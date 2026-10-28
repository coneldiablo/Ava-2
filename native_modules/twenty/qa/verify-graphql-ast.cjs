'use strict';

// Execute inside the rebuilt QA Twenty image. Unlike the local unit double,
// this loads the image's installed graphql parser and proves AST traversal.
const { assertSafeGraphqlDocument, isNativeGraphqlPath } = require('../install.cjs');
const denied = query => {
  try { assertSafeGraphqlDocument({ operationName: 'SafeName', query }); }
  catch (error) { return error.code === 'native_auth_mutation_forbidden'; }
  return false;
};
if (!denied('mutation SafeName { alias: generateApiKeyToken { token } }') ||
    !denied('query SafeName { ...Hidden } fragment Hidden on Query { updatePasswordViaResetToken { ok } }') ||
    !isNativeGraphqlPath('/metadata') || isNativeGraphqlPath('/other')) process.exitCode = 1;
