# Next.js 15 Image Cleaner — Free / No API

Ứng dụng Next.js 15 dùng **OpenCV.js** để inpaint vùng ảnh ngay trong trình duyệt.
Không cần API key, database hay backend xử lý ảnh.

> Chỉ dùng với ảnh bạn sở hữu hoặc có quyền chỉnh sửa.

## Tính năng

- Upload / kéo thả PNG, JPEG, WebP
- Brush tô mask và tẩy mask
- Undo và xóa toàn bộ mask
- Chọn thuật toán Telea hoặc Navier–Stokes
- Chỉnh inpaint radius
- Xử lý hoàn toàn client-side bằng OpenCV.js
- Tải kết quả PNG
- Tự giảm ảnh có cạnh lớn hơn 4096px để hạn chế trình duyệt hết bộ nhớ
- Không có route API

## Chạy local

Yêu cầu Node.js 20+.

```bash
npm install
npm run dev
```

Mở http://localhost:3000

## Build production

```bash
npm run build
npm start
```

Có thể deploy lên Vercel như app Next.js bình thường.

## OpenCV.js

Mặc định project tải bản prebuilt chính thức từ:

`https://docs.opencv.org/4.13.0/opencv.js`

Đây không phải API xử lý ảnh. File thư viện được browser tải xuống và việc xử lý pixel diễn ra trên thiết bị người dùng.

Nếu muốn tự host OpenCV.js, tải file `opencv.js` của OpenCV 4.13.0 vào `public/vendor/opencv.js`, sau đó đổi `OPENCV_URL` trong `components/ImageCleaner.tsx` thành:

```ts
const OPENCV_URL = "/vendor/opencv.js";
```

## Giới hạn chất lượng

Đây là inpainting cổ điển, không phải generative AI. Nó phù hợp nhất với vùng nhỏ trên nền tương đối đều. Với vùng lớn, mặt người, chữ hoặc texture phức tạp, kết quả có thể bị nhòe hay lặp pixel.

## License

Phần source code mẫu trong project này có thể tùy chỉnh cho dự án của bạn. OpenCV có license riêng của dự án OpenCV.


## Deploy lên Vercel

Project có `vercel.json` để ép Vercel nhận đúng Next.js và output `.next`.

Nếu project Vercel cũ đã từng đặt **Output Directory = public**, vào:

**Settings → Build and Deployment → Framework Settings**

- Framework Preset: `Next.js`
- Build Command: để mặc định hoặc `npm run build`
- Output Directory: tắt **Override** (khuyến nghị)
- Root Directory: để trống nếu `package.json` nằm ở root repository

Sau đó Redeploy.


## Giao diện

- Có nút chọn **Sáng / Tối** ngay trên đầu trang.
- Lựa chọn được lưu trong `localStorage`.
- Giới hạn file upload: **4 MB**.

## Branding & Google Analytics

- Logo: `public/logo.svg`
- Favicon SVG: `app/icon.svg`
- Favicon ICO: `app/favicon.ico`
- Apple icon: `app/apple-icon.png`
- Google Analytics Measurement ID: `G-8FMGRVQZY5`
- Google tag được nạp bằng `next/script` trong `app/layout.tsx` với `strategy="afterInteractive"`.
