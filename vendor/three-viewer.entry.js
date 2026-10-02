// Сборка для vendor/three-viewer.min.js:
// npx esbuild three-viewer.entry.js --bundle --minify --format=esm --target=es2019 --legal-comments=none --outfile=three-viewer.min.js
export {
  WebGLRenderer, Scene, PerspectiveCamera, Mesh, MeshStandardMaterial,
  HemisphereLight, DirectionalLight
} from 'three';
export { STLLoader } from 'three/addons/loaders/STLLoader.js';
export { OrbitControls } from 'three/addons/controls/OrbitControls.js';
export { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
