// Кадры протокола native messaging: 4 байта длины (uint32 LE) и JSON в UTF-8.

const HEADER_LENGTH = 4;

function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (buffer.length - offset >= HEADER_LENGTH) {
    const length = buffer.readUInt32LE(offset);
    if (buffer.length - offset - HEADER_LENGTH < length) {
      break;
    }

    const body = buffer.subarray(offset + HEADER_LENGTH, offset + HEADER_LENGTH + length);
    offset += HEADER_LENGTH + length;

    try {
      messages.push(JSON.parse(body.toString('utf8')));
    } catch {
      // Повреждённый кадр пропускаем: следующий разбор начнётся с корректной границы.
    }
  }

  return { messages, rest: buffer.subarray(offset) };
}

module.exports = { HEADER_LENGTH, encodeFrame, decodeFrames };
