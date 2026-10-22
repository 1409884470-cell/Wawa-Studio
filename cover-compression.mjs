// Native Electron decoding and JPEG encoding; original files are preserved by callers.
export function compressCoverBuffer(buf, nativeImage, maxBytes = 5 * 1024 * 1024) {
  let image = nativeImage.createFromBuffer(buf);
  if (image.isEmpty()) throw new Error('封面无法解码，请检查原图');
  if (buf.length <= maxBytes) return buf;
  for(let step=0;step<6;step++) {
    for(const quality of [90,82,72,60]) {
      const result=image.toJPEG(quality);
      if(result.length<=maxBytes)return result;
    }
    const {width,height}=image.getSize();
    image=image.resize({width:Math.max(1,Math.floor(width*.8)),height:Math.max(1,Math.floor(height*.8)),quality:'best'});
  }
  throw new Error('封面压缩后仍超过5MB，原图已保留');
}
