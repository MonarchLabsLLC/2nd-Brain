# Long-running Windows helper for 2nd Brain. Started by src/platform/win32.mjs.
# Reads one JSON request per line on stdin and writes one JSON reply per line on stdout.
#   {"id":1,"cmd":"attrs","paths":[...]}                  -> {"id":1,"ok":true,"result":[attributes or -1, ...]}
#   {"id":2,"cmd":"thumb","path":"...","out":"...","size":480} -> {"id":2,"ok":true}
#   {"id":3,"cmd":"recycle","paths":[...]}                -> {"id":3,"ok":true,"result":["path: reason", ...]}  (failures)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace SecondBrain {
  public static class Shell {
    // ---------- thumbnails: the same previews File Explorer shows ----------
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
    interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm); }
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx; public int cy; }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
      [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);

    const int SIIGBF_BIGGERSIZEOK = 0x1, SIIGBF_THUMBNAILONLY = 0x8;

    public static void Thumbnail(string path, string outPath, int size) {
      IShellItemImageFactory f;
      SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out f);
      IntPtr hbm = IntPtr.Zero;
      try {
        // THUMBNAILONLY: a real preview or nothing, never the generic file-type icon.
        int hr = f.GetImage(new SIZE { cx = size, cy = size }, SIIGBF_BIGGERSIZEOK | SIIGBF_THUMBNAILONLY, out hbm);
        if (hr != 0 || hbm == IntPtr.Zero) throw new Exception("No preview for this file");
        using (Bitmap src = WithAlpha(hbm)) {
          double scale = Math.Min(1.0, (double)size / Math.Max(src.Width, src.Height));
          int w = Math.Max(1, (int)Math.Round(src.Width * scale)), h = Math.Max(1, (int)Math.Round(src.Height * scale));
          using (Bitmap dst = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
            using (Graphics g = Graphics.FromImage(dst)) {
              g.InterpolationMode = InterpolationMode.HighQualityBicubic;
              bool jpg = outPath.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase);
              if (jpg) g.Clear(Color.White);
              g.DrawImage(src, 0, 0, w, h);
            }
            string tmp = outPath + ".tmp";
            dst.Save(tmp, outPath.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase) ? ImageFormat.Jpeg : ImageFormat.Png);
            if (File.Exists(outPath)) File.Delete(outPath);
            File.Move(tmp, outPath);
          }
        }
      } finally {
        if (hbm != IntPtr.Zero) DeleteObject(hbm);
        Marshal.ReleaseComObject(f);
      }
    }

    // Image.FromHbitmap drops transparency. Copy the 32-bit pixels and keep alpha when the preview has it.
    static Bitmap WithAlpha(IntPtr hbm) {
      using (Bitmap bmp = Image.FromHbitmap(hbm)) {
        if (Image.GetPixelFormatSize(bmp.PixelFormat) < 32) return new Bitmap(bmp);
        Rectangle r = new Rectangle(0, 0, bmp.Width, bmp.Height);
        int row = bmp.Width * 4;
        byte[] px = new byte[row * bmp.Height];
        BitmapData data = bmp.LockBits(r, ImageLockMode.ReadOnly, bmp.PixelFormat);
        try {
          // Copy row by row: the stride is negative when rows are stored bottom-up.
          for (int y = 0; y < bmp.Height; y++)
            Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), px, y * row, row);
        } finally { bmp.UnlockBits(data); }
        bool anyAlpha = false, allZero = true;
        for (int i = 3; i < px.Length; i += 4) { if (px[i] != 0) allZero = false; if (px[i] != 255) anyAlpha = true; }
        if (!anyAlpha || allZero) return new Bitmap(bmp); // opaque image (alpha bytes unused)
        Bitmap outBmp = new Bitmap(bmp.Width, bmp.Height, PixelFormat.Format32bppArgb);
        BitmapData od = outBmp.LockBits(r, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        try {
          for (int y = 0; y < bmp.Height; y++)
            Marshal.Copy(px, y * row, IntPtr.Add(od.Scan0, y * od.Stride), row);
        } finally { outBmp.UnlockBits(od); }
        return outBmp;
      }
    }

    // ---------- Recycle Bin ----------
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SHFILEOPSTRUCT {
      public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags;
      [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHFileOperation(ref SHFILEOPSTRUCT op);

    const uint FO_DELETE = 3;
    const ushort FOF_SILENT = 0x4, FOF_NOCONFIRMATION = 0x10, FOF_ALLOWUNDO = 0x40, FOF_NOERRORUI = 0x400, FOF_WANTNUKEWARNING = 0x4000;

    /// Sends each path to the Recycle Bin. Returns the paths that failed, with a reason.
    /// Never deletes permanently: drives without a Recycle Bin (USB sticks, network shares) are refused,
    /// and FOF_WANTNUKEWARNING makes Windows ask before it would delete a file too large for the bin.
    public static string[] Recycle(string[] paths) {
      List<string> failed = new List<string>();
      foreach (string p in paths) {
        try {
          string full = Path.GetFullPath(p);
          if (full.StartsWith(@"\\")) throw new Exception("network folders have no Recycle Bin");
          DriveInfo d = new DriveInfo(Path.GetPathRoot(full));
          if (d.DriveType != DriveType.Fixed) throw new Exception("this drive has no Recycle Bin, so 2nd Brain will not delete files on it");
          if (!File.Exists(full) && !Directory.Exists(full)) continue; // already gone
          SHFILEOPSTRUCT op = new SHFILEOPSTRUCT();
          op.wFunc = FO_DELETE;
          op.pFrom = full + "\0"; // the list ends with two nulls; the marshaller adds the second
          op.fFlags = (ushort)(FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING);
          int rc = SHFileOperation(ref op);
          if (rc != 0) throw new Exception("Windows error 0x" + rc.ToString("x"));
          if (op.fAnyOperationsAborted) throw new Exception("cancelled");
        } catch (Exception e) { failed.Add(p + ": " + e.Message); }
      }
      return failed.ToArray();
    }
  }
}
'@

function Reply($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

Reply @{ id = 0; ok = $true; result = 'ready' }
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    switch ($req.cmd) {
      'attrs' {
        $out = New-Object System.Collections.Generic.List[long]
        foreach ($p in @($req.paths)) {
          # Reading attributes never makes a cloud provider download the file.
          try { $out.Add([long][int][System.IO.File]::GetAttributes([string]$p)) } catch { $out.Add(-1) }
        }
        Reply @{ id = $req.id; ok = $true; result = $out.ToArray() }
      }
      'thumb' {
        [SecondBrain.Shell]::Thumbnail([string]$req.path, [string]$req.out, [int]$req.size)
        Reply @{ id = $req.id; ok = $true }
      }
      'recycle' {
        $failed = [SecondBrain.Shell]::Recycle([string[]]@($req.paths))
        Reply @{ id = $req.id; ok = $true; result = @($failed) }
      }
      default { Reply @{ id = $req.id; ok = $false; error = "Unknown command: $($req.cmd)" } }
    }
  } catch {
    $msg = $_.Exception.Message
    if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
    Reply @{ id = $(if ($req) { $req.id } else { -1 }); ok = $false; error = $msg }
  }
}
