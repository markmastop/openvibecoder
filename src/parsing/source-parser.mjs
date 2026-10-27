// The same pinned Prettier Babel parser is used in development and in the bundle.
// Parsing only: model code is never evaluated here.
let parser;
export async function parseJsx(source) {
  parser ||= import('../../parser/babel.mjs').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return import('prettier/plugins/babel.mjs');
  });
  return (await parser).parsers.babel.parse(source);
}
