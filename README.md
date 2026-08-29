# Next.js 15 Image Cleaner — Free / No API

Ứng dụng Next.js 15 phục hồi vùng ảnh **100% trong trình duyệt** bằng Web Worker local.
Không cần OpenCV CDN, API key, database hay backend xử lý ảnh.

> Chỉ dùng với ảnh bạn sở hữu hoặc có quyền chỉnh sửa.

## Tính năng

- Upload / kéo thả PNG, JPEG, WebP, tối đa **4 MB**
- Preview ảnh ngay sau khi chọn file
- Brush tô mask và tẩy mask
- Undo và xóa toàn bộ mask
- 2 chế độ phục hồi local: nhanh và mượt
- Chỉnh bán kính lấy mẫu pixel
- Xử lý trong `public/inpaint-worker.js`, không khóa giao diện chính
- Không tải OpenCV.js từ CDN nên tránh lỗi `Không tải được OpenCV.js`
- Tải kết quả PNG
- Ảnh lớn được thu về tối đa 2048px mỗi cạnh để xử lý và lưu phiên ổn định
- Không có route API xử lý ảnh
- Light / Dark theme
- Logo, favicon, Apple icon
- Google Analytics `G-8FMGRVQZY5`

## Phiên xử lý trên trình duyệt

App dùng `sessionStorage` để tự động lưu tạm:

- ảnh đang xử lý (WebP nén cục bộ)
- mask
- các thiết lập brush / radius / chế độ
- kết quả nếu dung lượng phiên còn đủ

Refresh trang trong **cùng tab** sẽ tự khôi phục phiên khi trình duyệt còn đủ quota.
Nút **Xóa phiên** xóa dữ liệu tạm của Image Cleaner khỏi `sessionStorage`.

Nếu trình duyệt không đủ quota để lưu ảnh lớn, app vẫn xử lý bình thường trong RAM nhưng có thể không khôi phục được sau refresh.

## Chạy local

Yêu cầu Node.js 20+.

```bash
npm install
npm run dev
```

Mở `http://localhost:3000`.

## Build production

```bash
npm run build
npm start
```

## Deploy Vercel

Project có `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "buildCommand": "npm run build",
  "outputDirectory": ".next"
}
```

Nếu Vercel project cũ đã đặt **Output Directory = public**, vào:

**Settings → Build and Deployment → Framework Settings**

- Framework Preset: `Next.js`
- Build Command: Default hoặc `npm run build`
- Output Directory: tắt **Override**
- Root Directory: để trống nếu `package.json` nằm ở root repo

Sau đó Redeploy.

## Engine xử lý ảnh

`public/inpaint-worker.js` là engine JavaScript local. Worker đọc pixel ảnh + mask, lan truyền màu từ biên vùng mask vào trong và làm mịn chỉ vùng được phục hồi.

Ưu điểm:

- không phụ thuộc CDN
- không có lỗi load OpenCV
- không upload ảnh
- không cần API key
- chạy được trên Vercel static/browser runtime

Đây vẫn là inpainting cổ điển, không phải generative AI. Nó phù hợp nhất với watermark/vùng nhỏ trên nền tương đối đều. Vùng lớn, mặt người, chữ hoặc texture phức tạp có thể cho kết quả nhòe.

## Branding & Google Analytics

- Logo: `public/logo.svg`
- Favicon SVG: `app/icon.svg`
- Favicon ICO: `app/favicon.ico`
- Apple icon: `app/apple-icon.png`
- Google Analytics Measurement ID: `G-8FMGRVQZY5`
- Google tag được nạp bằng `next/script` trong `app/layout.tsx`.
