// SVG's shared touch mixin imports this only inside Platform.OS === 'android'.
// The browser shim excludes native TurboModule loading from its dependency graph.
export default { playTouchSound(): never { throw new Error('Native touch sound is unavailable on web'); } };
