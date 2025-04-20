const fs = require('fs');
const path = require('path');

// 读取JSON文件
const jsonPath = path.resolve(__dirname, './src/xchain/eth/abi/ForceBridge.json');
const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

// 创建输出文件
const outputPath = path.resolve(__dirname, './src/xchain/eth/abi/ForceBridge.ts');
const outputDir = path.dirname(outputPath);

// 确保输出目录存在
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// 生成TypeScript文件
const tsContent = `// 自动生成的文件，请勿手动修改
export const ForceBridgeAbi = ${JSON.stringify(jsonData, null, 2)} as const;
`;

fs.writeFileSync(outputPath, tsContent);
console.log(`JSON data written to ${outputPath}`);