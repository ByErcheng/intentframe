import { downloadAsset, publicAssetUrl } from "./download-asset.ts";

// 保留既有图片入口；旧调用仍只接受图片，不改变其操作身份。
export const publicImageUrl = publicAssetUrl;
export function downloadImage(value: string, signal?: AbortSignal) { return downloadAsset(value, "image", signal); }
