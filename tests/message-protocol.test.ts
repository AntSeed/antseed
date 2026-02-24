import { describe, it, expect } from 'vitest';
import {
  encodeFrame,
  decodeFrame,
  FrameDecoder,
  MessageMux,
} from '../src/p2p/message-protocol.js';
import {
  MessageType,
  FRAME_HEADER_SIZE,
  MAX_PAYLOAD_SIZE,
  type FramedMessage,
} from '../src/types/protocol.js';

describe('encodeFrame / decodeFrame', () => {
  it('should round-trip a basic message', () => {
    const msg: FramedMessage = {
      type: MessageType.HttpRequest,
      messageId: 42,
      payload: new TextEncoder().encode('hello'),
    };

    const encoded = encodeFrame(msg);
    const result = decodeFrame(encoded);

    expect(result).not.toBeNull();
    expect(result!.message.type).toBe(MessageType.HttpRequest);
    expect(result!.message.messageId).toBe(42);
    expect(new TextDecoder().decode(result!.message.payload)).toBe('hello');
    expect(result!.bytesConsumed).toBe(FRAME_HEADER_SIZE + 5);
  });

  it('should round-trip a message with empty payload', () => {
    const msg: FramedMessage = {
      type: MessageType.Ping,
      messageId: 0,
      payload: new Uint8Array(0),
    };

    const encoded = encodeFrame(msg);
    const result = decodeFrame(encoded);

    expect(result).not.toBeNull();
    expect(result!.message.type).toBe(MessageType.Ping);
    expect(result!.message.payload.length).toBe(0);
    expect(result!.bytesConsumed).toBe(FRAME_HEADER_SIZE);
  });

  it('should throw for payload exceeding MAX_PAYLOAD_SIZE', () => {
    const msg: FramedMessage = {
      type: MessageType.HttpRequest,
      messageId: 1,
      payload: new Uint8Array(MAX_PAYLOAD_SIZE + 1),
    };
    expect(() => encodeFrame(msg)).toThrow('Payload too large');
  });

  it('should return null for incomplete header', () => {
    const data = new Uint8Array(5); // less than FRAME_HEADER_SIZE (9)
    expect(decodeFrame(data)).toBeNull();
  });

  it('should return null for incomplete payload', () => {
    // Create a valid header saying payload is 100 bytes, but only give 10
    const msg: FramedMessage = {
      type: MessageType.HttpRequest,
      messageId: 1,
      payload: new Uint8Array(100),
    };
    const encoded = encodeFrame(msg);
    // Truncate to header + 10 bytes
    const truncated = encoded.slice(0, FRAME_HEADER_SIZE + 10);
    expect(decodeFrame(truncated)).toBeNull();
  });

  it('should throw for decoded payload length exceeding MAX_PAYLOAD_SIZE', () => {
    const buf = new Uint8Array(FRAME_HEADER_SIZE);
    const view = new DataView(buf.buffer);
    view.setUint8(0, MessageType.HttpRequest);
    view.setUint32(1, 1);
    view.setUint32(5, MAX_PAYLOAD_SIZE + 1);
    expect(() => decodeFrame(buf)).toThrow('exceeds maximum');
  });

  it('should handle all message types', () => {
    for (const type of Object.values(MessageType).filter((v) => typeof v === 'number') as MessageType[]) {
      const msg: FramedMessage = { type, messageId: 1, payload: new Uint8Array(0) };
      const encoded = encodeFrame(msg);
      const decoded = decodeFrame(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.message.type).toBe(type);
    }
  });
});

describe('FrameDecoder', () => {
  it('should decode a single frame fed all at once', () => {
    const decoder = new FrameDecoder();
    const msg: FramedMessage = {
      type: MessageType.Pong,
      messageId: 7,
      payload: new TextEncoder().encode('pong'),
    };
    const encoded = encodeFrame(msg);
    const frames = decoder.feed(encoded);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.messageId).toBe(7);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('should decode multiple frames fed at once', () => {
    const decoder = new FrameDecoder();
    const msg1 = encodeFrame({ type: MessageType.Ping, messageId: 1, payload: new Uint8Array(0) });
    const msg2 = encodeFrame({ type: MessageType.Pong, messageId: 2, payload: new Uint8Array(0) });

    const combined = new Uint8Array(msg1.length + msg2.length);
    combined.set(msg1, 0);
    combined.set(msg2, msg1.length);

    const frames = decoder.feed(combined);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.messageId).toBe(1);
    expect(frames[1]!.messageId).toBe(2);
  });

  it('should handle partial frames across multiple feeds', () => {
    const decoder = new FrameDecoder();
    const msg = encodeFrame({
      type: MessageType.HttpRequest,
      messageId: 99,
      payload: new TextEncoder().encode('test payload'),
    });

    // Feed first half
    const half = Math.floor(msg.length / 2);
    const frames1 = decoder.feed(msg.slice(0, half));
    expect(frames1).toHaveLength(0);
    expect(decoder.bufferedBytes).toBe(half);

    // Feed second half
    const frames2 = decoder.feed(msg.slice(half));
    expect(frames2).toHaveLength(1);
    expect(frames2[0]!.messageId).toBe(99);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('should reset internal buffer', () => {
    const decoder = new FrameDecoder();
    decoder.feed(new Uint8Array(5)); // partial data
    expect(decoder.bufferedBytes).toBe(5);
    decoder.reset();
    expect(decoder.bufferedBytes).toBe(0);
  });
});

describe('MessageMux', () => {
  it('should dispatch to registered handler', async () => {
    const mux = new MessageMux();
    const received: FramedMessage[] = [];
    mux.on(MessageType.Ping, (msg) => {
      received.push(msg);
    });

    await mux.dispatch({ type: MessageType.Ping, messageId: 1, payload: new Uint8Array(0) });
    expect(received).toHaveLength(1);
  });

  it('should call default handler for unregistered types', async () => {
    const mux = new MessageMux();
    const defaultReceived: FramedMessage[] = [];
    mux.setDefaultHandler((msg) => {
      defaultReceived.push(msg);
    });

    await mux.dispatch({ type: MessageType.Error, messageId: 1, payload: new Uint8Array(0) });
    expect(defaultReceived).toHaveLength(1);
  });

  it('should not call default handler when type-specific handler exists', async () => {
    const mux = new MessageMux();
    let defaultCalled = false;
    mux.setDefaultHandler(() => {
      defaultCalled = true;
    });
    mux.on(MessageType.Ping, () => {});

    await mux.dispatch({ type: MessageType.Ping, messageId: 1, payload: new Uint8Array(0) });
    expect(defaultCalled).toBe(false);
  });

  it('should support multiple handlers per type', async () => {
    const mux = new MessageMux();
    let count = 0;
    mux.on(MessageType.Ping, () => { count++; });
    mux.on(MessageType.Ping, () => { count++; });

    await mux.dispatch({ type: MessageType.Ping, messageId: 1, payload: new Uint8Array(0) });
    expect(count).toBe(2);
  });

  it('should remove handler with off()', async () => {
    const mux = new MessageMux();
    let count = 0;
    const handler = () => { count++; };
    mux.on(MessageType.Ping, handler);
    mux.off(MessageType.Ping, handler);

    await mux.dispatch({ type: MessageType.Ping, messageId: 1, payload: new Uint8Array(0) });
    expect(count).toBe(0);
  });
});
