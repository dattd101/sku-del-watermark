import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Image Cleaner - Free Local Inpainting",
  description: "Chỉnh sửa vùng ảnh trực tiếp trong trình duyệt bằng OpenCV.js, không API key.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
