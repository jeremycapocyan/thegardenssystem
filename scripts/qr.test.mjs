import test from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import { PNG } from "pngjs";
import {
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
  QRCodeReader,
} from "@zxing/library";

test("printed court QR decodes to the attendance menu at mobile and print sizes", async () => {
  const value =
    "https://thegardenssystem.vercel.app/employee/scan/?court=11111111-1111-4111-8111-111111111111";
  for (const width of [300, 460]) {
    const png = PNG.sync.read(
      await QRCode.toBuffer(value, {
        width,
        errorCorrectionLevel: "M",
        margin: 4,
      }),
    );
    const pixels = new Uint8ClampedArray(png.width * png.height);
    for (let i = 0; i < pixels.length; i++)
      pixels[i] =
        (png.data[i * 4] + png.data[i * 4 + 1] * 2 + png.data[i * 4 + 2]) / 4;
    const decoded = new QRCodeReader().decode(
      new BinaryBitmap(
        new HybridBinarizer(
          new RGBLuminanceSource(pixels, png.width, png.height),
        ),
      ),
    );
    assert.equal(decoded.getText(), value);
  }
});
