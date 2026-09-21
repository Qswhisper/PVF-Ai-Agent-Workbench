"use strict";

const DATA = {
  0: "LOOP", 1: "SHADOW", 3: "COORD", 7: "IMAGE RATE", 8: "IMAGE ROTATE",
  9: "RGBA", 10: "INTERPOLATION", 11: "GRAPHIC EFFECT", 12: "DELAY",
  13: "DAMAGE TYPE", 14: "DAMAGE BOX", 15: "ATTACK BOX", 16: "PLAY SOUND",
  17: "PRELOAD", 18: "SPECTRUM", 23: "SET FLAG", 24: "FLIP TYPE",
  25: "LOOP START", 26: "LOOP END", 27: "CLIP", 28: "OPERATION",
};
const EFFECT = ["NONE", "DODGE", "LINEARDODGE", "DARK", "XOR", "MONOCHROME", "SPACEDISTORT"];
const DAMAGE = ["NORMAL", "SUPERARMOR", "UNBREAKABLE"];
const FLIP = [undefined, "HORIZON", "VERTICAL", "ALL"];

function inspectBinaryAni(buffer: Buffer): {
  text: string;
  fields: Array<Record<string, unknown>>;
  byteLength: number;
  consumedBytes: number;
  fullyConsumed: boolean;
} | null {
  try {
    let position = 0;
    let outputLength = 0;
    const fields: Array<Record<string, unknown>> = [];
    const requireBytes = (count: number): void => {
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(position + count) || position + count > buffer.length) {
        throw new Error("Unexpected or unsafe binary ANI length.");
      }
    };
    const u8 = () => { requireBytes(1); return buffer[position++]; };
    const u16 = () => { requireBytes(2); const value = buffer.readUInt16LE(position); position += 2; return value; };
    const i16 = () => { requireBytes(2); const value = buffer.readInt16LE(position); position += 2; return value; };
    const i32 = () => { requireBytes(4); const value = buffer.readInt32LE(position); position += 4; return value; };
    const f32 = () => { requireBytes(4); const value = buffer.readFloatLE(position); position += 4; return value; };
    const ascii = (length: number): string => { requireBytes(length); const value = buffer.subarray(position, position + length).toString("ascii"); position += length; return value; };
    const color = () => (256 + u8()) % 256;
    const readNumeric = (reader: () => number, width: number, kind: string) => {
      const offset = position;
      const value = reader();
      return { value, offset, width, kind };
    };

    const frameCount = readNumeric(u16, 2, "u16");
    const imageCount = u16();
    const images = [];
    for (let index = 0; index < imageCount; index += 1) images.push(ascii(i32()));

    const output = ["#PVF_File\r\n"];
    outputLength = output[0].length;
    const append = (value: string): number => { outputLength += value.length; return output.push(value); };
    const appendNumeric = (value: string, offset: number, width: number, kind: string, tag: string): void => {
      const start = outputLength;
      append(value);
      fields.push({ start, end: outputLength, offset, width, kind, tag, text: value });
    };
    const appendField = (field: { value: number; offset: number; width: number; kind: string }, tag: string, format: (value: number) => string = (value) => String(value)): void => {
      appendNumeric(format(field.value), field.offset, field.width, field.kind, tag);
    };
    const overallCount = u16();
    for (let index = 0; index < overallCount; index += 1) {
      const type = u16();
      if (type === 0 || type === 1) {
        append(`[${DATA[type]}]\r\n\t`);
        appendField(readNumeric(u8, 1, "u8"), DATA[type]);
        append("\r\n");
      }
      else if (type === 3 || type === 28) {
        append(`[${DATA[type]}]\r\n\t`);
        appendField(readNumeric(u16, 2, "u16"), DATA[type]);
        append("\r\n");
      }
      else if (type === 18) {
        append("[SPECTRUM]\r\n\t");
        appendField(readNumeric(u8, 1, "u8"), "SPECTRUM");
        append("\r\n\t[SPECTRUM TERM]\r\n\t\t");
        appendField(readNumeric(i32, 4, "i32"), "SPECTRUM TERM");
        append("\r\n\t[SPECTRUM LIFE TIME]\r\n\t\t");
        appendField(readNumeric(i32, 4, "i32"), "SPECTRUM LIFE TIME");
        append("\r\n\t[SPECTRUM COLOR]\r\n\t\t");
        appendField(readNumeric(color, 1, "u8"), "SPECTRUM COLOR"); append("\t");
        appendField(readNumeric(color, 1, "u8"), "SPECTRUM COLOR"); append("\t");
        appendField(readNumeric(color, 1, "u8"), "SPECTRUM COLOR"); append("\t");
        appendField(readNumeric(color, 1, "u8"), "SPECTRUM COLOR"); append("\r\n");
        const effect = u16();
        append(`\t[SPECTRUM EFFECT]\r\n\t\t\`${EFFECT[effect] || "UNKNOWN"}\`\r\n`);
      } else return null;
    }

    append("[FRAME MAX]\r\n\t");
    appendField(frameCount, "FRAME MAX");
    append("\r\n");
    for (let frame = 0; frame < frameCount.value; frame += 1) {
      append(`\r\n[FRAME${String(frame).padStart(3, "0")}]\r\n`);
      const boxCount = u16();
      const boxes: Array<{ type: number; fields: Array<Record<string, unknown>> }> = [];
      for (let index = 0; index < boxCount; index += 1) {
        const type = u16();
        if (type !== 14 && type !== 15) return null;
        boxes.push({
          type,
          fields: Array.from({ length: 6 }, () => readNumeric(i32, 4, "i32")),
        });
      }

      append("\t[IMAGE]\r\n");
      const imageIndex = i16();
      if (imageIndex >= 0) {
        if (!images[imageIndex]) return null;
        append(`\t\t\`${images[imageIndex]}\`\r\n\t\t`);
        appendField(readNumeric(u16, 2, "u16"), "IMAGE");
        append("\r\n");
      } else append("\t\t``\r\n\t\t0\r\n");
      append("\t[IMAGE POS]\r\n\t\t");
      appendField(readNumeric(i32, 4, "i32"), "IMAGE POS"); append("\t");
      appendField(readNumeric(i32, 4, "i32"), "IMAGE POS"); append("\r\n");

      const itemCount = u16();
      for (let index = 0; index < itemCount; index += 1) {
        const type = u16();
        if ([0, 1, 10].includes(type)) {
          append(`\t[${DATA[type]}]\r\n\t\t`);
          appendField(readNumeric(u8, 1, "u8"), DATA[type]);
          append("\r\n");
        }
        else if (type === 3) {
          append("\t[COORD]\r\n\t\t");
          appendField(readNumeric(u16, 2, "u16"), "COORD");
          append("\r\n");
        }
        else if (type === 17) append("\t[PRELOAD]\r\n\t\t1\r\n");
        else if (type === 7) {
          append("\t[IMAGE RATE]\r\n\t\t");
          appendField(readNumeric(f32, 4, "f32"), "IMAGE RATE", (value) => value.toFixed(2)); append("\t");
          appendField(readNumeric(f32, 4, "f32"), "IMAGE RATE", (value) => value.toFixed(2)); append("\r\n");
        }
        else if (type === 8) {
          append("\t[IMAGE ROTATE]\r\n\t\t");
          appendField(readNumeric(f32, 4, "f32"), "IMAGE ROTATE", (value) => value.toFixed(2)); append("\r\n");
        }
        else if (type === 9) {
          append("\t[RGBA]\r\n\t\t");
          appendField(readNumeric(color, 1, "u8"), "RGBA"); append("\t");
          appendField(readNumeric(color, 1, "u8"), "RGBA"); append("\t");
          appendField(readNumeric(color, 1, "u8"), "RGBA"); append("\t");
          appendField(readNumeric(color, 1, "u8"), "RGBA"); append("\r\n");
        }
        else if (type === 11) {
          const effect = u16();
          append(`\t[GRAPHIC EFFECT]\r\n\t\t\`${EFFECT[effect] || "UNKNOWN"}\`\r\n`);
          if (effect === 5) {
            append("\t\t");
            appendField(readNumeric(color, 1, "u8"), "GRAPHIC EFFECT"); append("\t");
            appendField(readNumeric(color, 1, "u8"), "GRAPHIC EFFECT"); append("\t");
            appendField(readNumeric(color, 1, "u8"), "GRAPHIC EFFECT"); append("\r\n");
          }
          if (effect === 6) {
            append("\t\t");
            appendField(readNumeric(i16, 2, "i16"), "GRAPHIC EFFECT"); append("\t");
            appendField(readNumeric(i16, 2, "i16"), "GRAPHIC EFFECT"); append("\r\n");
          }
        } else if (type === 12) {
          append("\t[DELAY]\r\n\t\t");
          appendField(readNumeric(i32, 4, "i32"), "DELAY");
          append("\r\n");
        }
        else if (type === 13) {
          const damage = u16();
          append(`\t[DAMAGE TYPE]\r\n\t\t\`${DAMAGE[damage] || "UNKNOWN"}\`\r\n`);
        }
        else if (type === 16) append(`\t[PLAY SOUND]\r\n\t\t\`${ascii(i32())}\`\r\n`);
        else if (type === 23) {
          append("\t[SET FLAG]\r\n\t\t");
          appendField(readNumeric(i32, 4, "i32"), "SET FLAG");
          append("\r\n");
        }
        else if (type === 24) {
          const flip = u16();
          append(`\t[FLIP TYPE]\r\n\t\t\`${FLIP[flip] || "UNKNOWN"}\`\r\n`);
        }
        else if (type === 25) append("\t[LOOP START]\r\n");
        else if (type === 26) {
          append("\t[LOOP END]\r\n\t\t");
          appendField(readNumeric(i32, 4, "i32"), "LOOP END");
          append("\r\n");
        }
        else if (type === 27) {
          append("\t[CLIP]\r\n\t\t");
          appendField(readNumeric(i16, 2, "i16"), "CLIP"); append("\t");
          appendField(readNumeric(i16, 2, "i16"), "CLIP"); append("\t");
          appendField(readNumeric(i16, 2, "i16"), "CLIP"); append("\t");
          appendField(readNumeric(i16, 2, "i16"), "CLIP"); append("\r\n");
        }
        else return null;
      }
      for (const box of boxes) {
        append(`\t[${DATA[box.type]}]\r\n\t`);
        box.fields.forEach((field, index) => {
          appendField(field as { value: number; offset: number; width: number; kind: string }, DATA[box.type]);
          if (index < box.fields.length - 1) append("\t");
        });
        append("\r\n");
      }
    }
    return {
      text: output.join(""),
      fields,
      byteLength: buffer.length,
      consumedBytes: position,
      fullyConsumed: position === buffer.length,
    };
  } catch {
    return null;
  }
}

function decompileBinaryAni(buffer: Buffer): string | null {
  return inspectBinaryAni(buffer)?.text || null;
}

module.exports = { decompileBinaryAni, inspectBinaryAni };
