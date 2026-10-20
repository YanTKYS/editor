// jsdom は Range のレイアウト API を実装していないため、CodeMirror の寸法計測用に補う
if (typeof Range !== 'undefined') {
  const empty = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects ??= empty;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);
}
