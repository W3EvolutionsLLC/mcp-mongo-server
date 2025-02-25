const { execSync } = require('child_process');
try {
  const result = execSync('npx tsc --noEmit', {stdio: 'pipe'});
  console.log("TypeScript check passed!");
  console.log(result.toString());
} catch (error) {
  console.error("TypeScript check failed!");
  console.error(error.message);
}