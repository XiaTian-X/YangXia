// 纯前端零依赖的 WebM（Matroska EBML + Cues 索引）封装器：把 WebCodecs 编好的视频、音频数据块封成 .webm。
// 照原版编排器原样移植（apps/sequencer/reference/原版.html），保留 JS，对外类型见 webm-muxer.d.ts。
export function createSimpleWebmMuxer({ width, height, fps, videoCodecId, sampleRate, channels, durationMs }) {
  const packets = [];

  function writeVintSize(size) {
    if (size < 0x7F) return new Uint8Array([0x80 | size]);
    if (size < 0x3FFF) return new Uint8Array([0x40 | ((size >> 8) & 0x3F), size & 0xFF]);
    if (size < 0x1FFFFF) return new Uint8Array([0x20 | ((size >> 16) & 0x1F), (size >> 8) & 0xFF, size & 0xFF]);
    if (size < 0x0FFFFFFF) {
      return new Uint8Array([
        0x10 | ((size >> 24) & 0x0F),
        (size >> 16) & 0xFF,
        (size >> 8) & 0xFF,
        size & 0xFF
      ]);
    }
    const hi = Math.floor(size / 0x100000000);
    const lo = size >>> 0;
    return new Uint8Array([
      0x01,
      (hi >> 16) & 0xFF,
      (hi >> 8) & 0xFF,
      hi & 0xFF,
      (lo >>> 24) & 0xFF,
      (lo >>> 16) & 0xFF,
      (lo >>> 8) & 0xFF,
      lo & 0xFF
    ]);
  }

  function concatArrays(arrays) {
    let total = 0;
    for (let i = 0; i < arrays.length; i++) total += arrays[i].byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < arrays.length; i++) {
      out.set(arrays[i], offset);
      offset += arrays[i].byteLength;
    }
    return out;
  }

  function ebmlElement(idBytes, payload) {
    const data = payload instanceof Uint8Array ? payload : concatArrays(payload);
    const idArr = idBytes instanceof Uint8Array ? idBytes : new Uint8Array(idBytes);
    const sizeArr = writeVintSize(data.byteLength);
    return concatArrays([idArr, sizeArr, data]);
  }

  function ebmlUint(idBytes, val) {
    const v = Math.max(0, Math.round(val));
    const bytes = [];
    let temp = v;
    while (temp > 0) {
      bytes.unshift(temp & 0xFF);
      temp = Math.floor(temp / 256);
    }
    if (bytes.length === 0) bytes.push(0);
    return ebmlElement(idBytes, new Uint8Array(bytes));
  }

  function ebmlFloat64(idBytes, val) {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, val, false);
    return ebmlElement(idBytes, new Uint8Array(buf));
  }

  function ebmlAscii(idBytes, str) {
    const arr = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0x7F;
    return ebmlElement(idBytes, arr);
  }

  function makeOpusHead(rate, ch) {
    const buf = new ArrayBuffer(19);
    const view = new DataView(buf);
    const magic = 'OpusHead';
    for (let i = 0; i < 8; i++) view.setUint8(i, magic.charCodeAt(i));
    view.setUint8(8, 1);
    view.setUint8(9, ch);
    view.setUint16(10, 312, true);
    view.setUint32(12, rate, true);
    view.setUint16(16, 0, true);
    view.setUint8(18, 0);
    return new Uint8Array(buf);
  }

  function addVideoChunk(dataUint8, timestampUs, isKey) {
    packets.push({
      trackNum: 1,
      timeMs: Math.max(0, Math.round(timestampUs / 1000)),
      isKey: !!isKey,
      data: dataUint8
    });
  }

  function addAudioChunk(dataUint8, timestampUs) {
    packets.push({
      trackNum: 2,
      timeMs: Math.max(0, Math.round(timestampUs / 1000)),
      isKey: true,
      data: dataUint8
    });
  }

  function finalize() {
    packets.sort((a, b) => {
      if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
      return a.trackNum - b.trackNum;
    });

    const ebmlHeader = ebmlElement([0x1A, 0x45, 0xDF, 0xA3], [
      ebmlUint([0x42, 0x86], 1),
      ebmlUint([0x42, 0xF7], 1),
      ebmlUint([0x42, 0xF2], 4),
      ebmlUint([0x42, 0xF3], 8),
      ebmlAscii([0x42, 0x82], 'webm'),
      ebmlUint([0x42, 0x87], 4),
      ebmlUint([0x42, 0x85], 2)
    ]);

    const segmentInfo = ebmlElement([0x15, 0x49, 0xA9, 0x66], [
      ebmlUint([0x2A, 0xD7, 0xB1], 1000000),
      ebmlAscii([0x4D, 0x80], 'KeepCourseSequencer-WebCodecs'),
      ebmlAscii([0x57, 0x41], 'KeepCourseSequencer-WebCodecs'),
      ebmlFloat64([0x44, 0x89], Math.max(100, durationMs))
    ]);

    const defaultFrameNs = Math.round(1000000000 / (fps || 60));
    const videoTrackEntry = ebmlElement([0xAE], [
      ebmlUint([0xD7], 1),
      ebmlUint([0x73, 0xC5], 1),
      ebmlUint([0x9C], 0),
      ebmlAscii([0x22, 0xB5, 0x9C], 'und'),
      ebmlAscii([0x86], videoCodecId || 'V_VP9'),
      ebmlUint([0x83], 1),
      ebmlUint([0x23, 0xE3, 0x83], defaultFrameNs),
      ebmlElement([0xE0], [
        ebmlUint([0xB0], width),
        ebmlUint([0xBA], height)
      ])
    ]);

    const audioTrackEntry = ebmlElement([0xAE], [
      ebmlUint([0xD7], 2),
      ebmlUint([0x73, 0xC5], 2),
      ebmlUint([0x9C], 0),
      ebmlAscii([0x22, 0xB5, 0x9C], 'und'),
      ebmlAscii([0x86], 'A_OPUS'),
      ebmlUint([0x83], 2),
      ebmlUint([0x56, 0xAA], 6500000),
      ebmlUint([0x56, 0xBB], 80000000),
      ebmlElement([0x63, 0xA2], makeOpusHead(sampleRate, channels)),
      ebmlElement([0xE1], [
        ebmlFloat64([0xB5], sampleRate),
        ebmlUint([0x9F], channels),
        ebmlUint([0x62, 0x64], 32)
      ])
    ]);

    const tracksElement = ebmlElement([0x16, 0x54, 0xAE, 0x6B], [
      videoTrackEntry,
      audioTrackEntry
    ]);

    const clustersData = [];
    let currentCluster = null;

    function flushCurrentCluster() {
      if (!currentCluster || currentCluster.blocks.length === 0) return;
      const clusterTimeEl = ebmlUint([0xE7], currentCluster.timecode);
      const clusterEl = ebmlElement([0x1F, 0x43, 0xB6, 0x75], [
        clusterTimeEl,
        ...currentCluster.blocks
      ]);
      clustersData.push({
        timecode: currentCluster.timecode,
        hasVideoKeyframe: currentCluster.hasVideoKeyframe,
        bytes: clusterEl
      });
      currentCluster = null;
    }

    for (let i = 0; i < packets.length; i++) {
      const pkt = packets[i];
      const needNewCluster = !currentCluster ||
        (pkt.trackNum === 1 && pkt.isKey && (pkt.timeMs - currentCluster.timecode) >= 400) ||
        (pkt.timeMs - currentCluster.timecode) >= 2500 ||
        (pkt.timeMs - currentCluster.timecode) < 0;

      if (needNewCluster) {
        flushCurrentCluster();
        currentCluster = {
          timecode: pkt.timeMs,
          hasVideoKeyframe: pkt.trackNum === 1 && pkt.isKey,
          blocks: []
        };
      } else if (pkt.trackNum === 1 && pkt.isKey) {
        currentCluster.hasVideoKeyframe = true;
      }

      const relTime = Math.max(-32768, Math.min(32767, pkt.timeMs - currentCluster.timecode));
      const blockHeader = new Uint8Array(4);
      blockHeader[0] = 0x80 | (pkt.trackNum & 0x7F);
      blockHeader[1] = (relTime >> 8) & 0xFF;
      blockHeader[2] = relTime & 0xFF;
      blockHeader[3] = pkt.isKey ? 0x80 : 0x00;

      const simpleBlock = ebmlElement([0xA3], [blockHeader, pkt.data]);
      currentCluster.blocks.push(simpleBlock);
    }
    flushCurrentCluster();

    // 计算每个关键帧 Cluster 在 Segment 数据区内的相对字节偏移，生成 Cues 索引表支持任意拖动进度条
    let runningSegmentOffset = segmentInfo.byteLength + tracksElement.byteLength;
    const cuePoints = [];
    for (let i = 0; i < clustersData.length; i++) {
      const cl = clustersData[i];
      if (cl.hasVideoKeyframe || i === 0) {
        const cueTrackPos = ebmlElement([0xB7], [
          ebmlUint([0xF7], 1),
          ebmlUint([0xF1], runningSegmentOffset)
        ]);
        const cuePoint = ebmlElement([0xBB], [
          ebmlUint([0xB3], cl.timecode),
          cueTrackPos
        ]);
        cuePoints.push(cuePoint);
      }
      runningSegmentOffset += cl.bytes.byteLength;
    }

    const cuesElement = cuePoints.length > 0
      ? ebmlElement([0x1C, 0x53, 0xBB, 0x6B], cuePoints)
      : new Uint8Array(0);

    let totalSegmentSize = segmentInfo.byteLength + tracksElement.byteLength + cuesElement.byteLength;
    for (let i = 0; i < clustersData.length; i++) {
      totalSegmentSize += clustersData[i].bytes.byteLength;
    }
    const segmentHeader = concatArrays([
      new Uint8Array([0x18, 0x53, 0x80, 0x67]),
      writeVintSize(totalSegmentSize)
    ]);

    return new Blob([
      ebmlHeader,
      segmentHeader,
      segmentInfo,
      tracksElement,
      ...clustersData.map(c => c.bytes),
      cuesElement
    ], { type: 'video/webm' });
  }

  return {
    addVideoChunk,
    addAudioChunk,
    finalize
  };
}
