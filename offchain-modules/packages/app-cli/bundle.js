const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

// 检测项目中的原生模块
const detectNativeModules = () => {
  try {
    const packageJson = require('./package.json');
    const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    
    // 常见的原生模块列表
    const commonNativeModules = [
      'snappy', 'leveldown', 'secp256k1', 'keccak', 'sqlite3', 'node-gyp',
      'canvas', 'bcrypt', 'sharp', 'node-sass', 'fibers', 'grpc', 'keytar',
      'node-expat', 'node-gyp-build', 'node-pre-gyp', 'node-addon-api'
    ];
    
    // 返回项目中使用的原生模块
    return Object.keys(allDeps).filter(dep => commonNativeModules.includes(dep));
  } catch (e) {
    console.warn('Failed to detect native modules:', e);
    // 返回保守的默认列表
    return ['snappy', 'leveldown', 'secp256k1'];
  }
};

const nativeModules = detectNativeModules();
console.log('Detected native modules (will be marked as external):', nativeModules);

(async () => {
  try {
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, './src/index.ts')],
      bundle: true,
      platform: 'node',
      target: 'node18',
      outfile: path.resolve(__dirname, './dist/index.js'),
      minify: true,
      
      // 标记所有原生模块为外部依赖
      external: [
        'nconf',
        ...nativeModules,
        'undici',
        'node-fetch',
        'abort-controller'
        // 其他可能需要排除的模块
      ],
    });

    // 设置可执行权限
    fs.chmodSync(path.resolve(__dirname, './dist/index.js'), '755');
    
    console.log('Build completed successfully!');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
})();