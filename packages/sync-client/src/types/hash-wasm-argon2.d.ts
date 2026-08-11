declare module "hash-wasm/dist/argon2.umd.min.js" {
  import type { argon2id } from "hash-wasm";

  const mod: {
    default?: {
      argon2id?: typeof argon2id;
    };
    "module.exports"?: {
      argon2id?: typeof argon2id;
    };
  };

  export default mod;
}
