class DOMMatrixMock {
  static fromFloat32Array(_array: Float32Array): DOMMatrixMock {
    return new DOMMatrixMock();
  }

  static fromFloat64Array(_array: Float64Array): DOMMatrixMock {
    return new DOMMatrixMock();
  }

  multiplySelf(): DOMMatrixMock {
    return this;
  }

  preMultiplySelf(): DOMMatrixMock {
    return this;
  }

  translateSelf(): DOMMatrixMock {
    return this;
  }

  scaleSelf(): DOMMatrixMock {
    return this;
  }

  rotateSelf(): DOMMatrixMock {
    return this;
  }

  invertSelf(): DOMMatrixMock {
    return this;
  }
}

if (typeof globalThis.DOMMatrix === 'undefined') {
  (globalThis as { DOMMatrix?: typeof DOMMatrixMock }).DOMMatrix = DOMMatrixMock;
}
