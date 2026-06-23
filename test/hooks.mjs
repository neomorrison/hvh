import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve as presolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stub = pathToFileURL(presolve(here, 'three-stub.mjs')).href;
const addonStub = pathToFileURL(presolve(here, 'three-addons-stub.mjs')).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'three') return { url: stub, shortCircuit: true };
  if (specifier.startsWith('three/addons/')) return { url: addonStub, shortCircuit: true };
  return next(specifier, context);
}
