"use strict";

var DeepSeekZip = (() => {
  const textEncoder = new TextEncoder();
  const crcTable = buildCrcTable();

  function createZipBytes(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of entries) {
      const pathBytes = encodeText(normalizePath(entry.path));
      const dataBytes = toBytes(entry.data);
      const crc = crc32(dataBytes);
      const timeDate = dosTimeDate(new Date());
      const localHeader = createLocalHeader(pathBytes, dataBytes.length, crc, timeDate);
      const centralHeader = createCentralHeader(pathBytes, dataBytes.length, crc, timeDate, offset);

      localParts.push(localHeader, pathBytes, dataBytes);
      centralParts.push(centralHeader, pathBytes);
      offset += localHeader.length + pathBytes.length + dataBytes.length;
    }

    const centralOffset = offset;
    const centralSize = byteLength(centralParts);
    const endRecord = createEndRecord(entries.length, centralSize, centralOffset);
    return concatBytes([...localParts, ...centralParts, endRecord]);
  }

  function createLocalHeader(pathBytes, size, crc, timeDate) {
    const bytes = new Uint8Array(30);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, timeDate.time, true);
    view.setUint16(12, timeDate.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, pathBytes.length, true);
    view.setUint16(28, 0, true);
    return bytes;
  }

  function createCentralHeader(pathBytes, size, crc, timeDate, offset) {
    const bytes = new Uint8Array(46);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, timeDate.time, true);
    view.setUint16(14, timeDate.date, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, size, true);
    view.setUint32(24, size, true);
    view.setUint16(28, pathBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, offset, true);
    return bytes;
  }

  function createEndRecord(entryCount, centralSize, centralOffset) {
    const bytes = new Uint8Array(22);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, entryCount, true);
    view.setUint16(10, entryCount, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
    view.setUint16(20, 0, true);
    return bytes;
  }

  function dosTimeDate(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[index]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function buildCrcTable() {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    return table;
  }

  function toBytes(value) {
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    return encodeText(String(value || ""));
  }

  function encodeText(value) {
    return textEncoder.encode(value);
  }

  function normalizePath(path) {
    return String(path || "file")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+/g, "/");
  }

  function byteLength(parts) {
    return parts.reduce((total, part) => total + part.length, 0);
  }

  function concatBytes(parts) {
    const output = new Uint8Array(byteLength(parts));
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  return {
    createZipBytes
  };
})();
