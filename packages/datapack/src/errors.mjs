/** Structured dis-datapack/v1 failures; W5-02 maps these to CT-06 HTTP errors after CT-06 merges. */
export class DataPackError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = "DataPackError";
    this.code = code;
    this.detail = detail;
  }
}

export function dataPackInvalid(message, detail = undefined) {
  return new DataPackError("CONTENT_PACK_INVALID", message, detail);
}

export function dataPackSignatureInvalid(message, detail = undefined) {
  return new DataPackError("CONTENT_PACK_SIGNATURE_INVALID", message, detail);
}
