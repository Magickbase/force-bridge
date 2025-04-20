const esbuild = require('esbuild');
const path = require('path');

(async () => {
  try {
    const result = await esbuild.build({
      entryPoints: [path.resolve(__dirname, '../src/index.ts')],
      bundle: true,
      platform: 'node',
      target: 'node14',
      outfile: path.resolve(__dirname, '../dist/cli-bundle.js'),
      // 外部化不需要打包的依赖（如果有的话）
      // external: ['some-native-dependency'],
    });
    console.log('Build completed successfully!');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
})();