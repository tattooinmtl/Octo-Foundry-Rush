/** Resolve extensionless TypeScript imports for plain `node` execution. */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.startsWith('.') && !/\.(ts|mjs|js)$/.test(specifier)) {
      return await next(`${specifier}.ts`, context);
    }
    throw err;
  }
}
