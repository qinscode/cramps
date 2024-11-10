// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('close', (event) => {
    app.quit();
  });
}

// 应用程序生命周期处理
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (mainWindow) {
    mainWindow.removeAllListeners('close');
    mainWindow.close();
  }
});

// 检查 handler 是否已经注册
const registeredHandlers = new Set();

// 注册处理程序的辅助函数
function registerHandler(channel, handler) {
  if (!registeredHandlers.has(channel)) {
    ipcMain.handle(channel, handler);
    registeredHandlers.add(channel);
  }
}


// 注册确保输出目录存在的处理程序
registerHandler('ensure-output-directory', async () => {
  const outputDir = '/Users/fudong/Downloads/output';
  try {
    await fs.mkdir(outputDir, { recursive: true });
    return true;
  } catch (err) {
    throw new Error(`无法创建输出目录: ${err.message}`);
  }
});

// 修改文件夹选择对话框的处理程序
registerHandler('dialog:openDirectory', async (event, type) => {
  let defaultPath = '/Users/fudong/Projects';  // 默认源文件夹路径
  let properties = ['createDirectory'];
  
  // 如果是源文件夹，允许多选文件和文件夹
  if (type === 'source') {
    properties.push('openDirectory', 'openFile', 'multiSelections');
  } else {
    properties.push('openDirectory');
  }

  // 如果是选择目标文件夹，则使用输出文件夹路径
  if (type === 'target') {
    defaultPath = '/Users/fudong/Downloads/output';
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: defaultPath,
    properties: properties,
    title: type === 'target' ? '选择文件夹' : '选择文件或文件夹',
    buttonLabel: '选择',
    message: type === 'target' ? '选择输出文件夹' : '选择文件或文件夹',
    promptToCreate: true,
  });

  if (!result.canceled) {
    return type === 'source' ? result.filePaths : result.filePaths[0];
  }
  return null;
});

// 修改获取所有文件的函数，增加对单个文件的支持
async function getAllFiles(sourcePath) {
  try {
    const stats = await fs.stat(sourcePath);
    
    // 如果是文件，直接返回文件信息
    if (stats.isFile()) {
      return [{
        path: sourcePath,
        name: path.basename(sourcePath)
      }];
    }
    
    // 如果是目录，递归获取所有文件
    const files = await fs.readdir(sourcePath, { withFileTypes: true });
    let paths = [];

    for (const file of files) {
      const fullPath = path.join(sourcePath, file.name);
      if (file.isDirectory()) {
        paths = paths.concat(await getAllFiles(fullPath));
      } else {
        paths.push({
          path: fullPath,
          name: file.name
        });
      }
    }

    return paths;
  } catch (err) {
    console.error(`Error processing path ${sourcePath}:`, err);
    return [];
  }
}

// 添加删除目录内容的函数
async function emptyDirectory(directoryPath) {
  try {
    const items = await fs.readdir(directoryPath);
    for (const item of items) {
      const fullPath = path.join(directoryPath, item);
      const stat = await fs.stat(fullPath);
      
      if (stat.isDirectory()) {
        await emptyDirectory(fullPath);
        await fs.rmdir(fullPath);
      } else {
        await fs.unlink(fullPath);
      }
    }
  } catch (err) {
    console.error('清空目录时出错:', err);
    throw err;
  }
}

// 修改复制处理请求
ipcMain.on('start-copy', async (event, { sourcePaths, targetPath }) => {
  try {
    // 检查所有源路径是否存在
    for (const sourcePath of sourcePaths) {
      const sourceExists = await fs.access(sourcePath)
        .then(() => true)
        .catch(() => false);

      if (!sourceExists) {
        event.reply('copy-error', `源路径不存在：${sourcePath}`);
        return;
      }

      // 获取源路径的状态
      const sourceStats = await fs.stat(sourcePath);
      
      // 如果是目录，进行目录相关检查
      if (sourceStats.isDirectory()) {
        const sourceResolved = path.resolve(sourcePath);
        const targetResolved = path.resolve(targetPath);

        if (sourceResolved === targetResolved) {
          event.reply('copy-error', '源文件夹和目标文件夹不能相同！');
          return;
        }

        if (targetResolved.startsWith(sourceResolved)) {
          event.reply('copy-error', '目标文件夹不能是源文件夹的子目录！');
          return;
        }
      }
    }

    // 确保目标目录存在
    await fs.mkdir(targetPath, { recursive: true });

    // 清空目标目录
    try {
      await emptyDirectory(targetPath);
    } catch (err) {
      event.reply('copy-error', `清空目标文件夹失败: ${err.message}`);
      return;
    }

    // 复制所有选中的文件和文件夹
    let totalFilesCopied = 0;
    let totalFilesCount = 0;

    // 首先计算所有文件的总数
    for (const sourcePath of sourcePaths) {
      const files = await getAllFiles(sourcePath);
      totalFilesCount += files.length;
    }

    // 依次复制每个文件/文件夹
    for (const sourcePath of sourcePaths) {
      await copyFolder(sourcePath, targetPath, event, totalFilesCopied, totalFilesCount);
      const files = await getAllFiles(sourcePath);
      totalFilesCopied += files.length;
    }
  } catch (err) {
    event.reply('copy-error', err.message);
  }
});

// 修改复制文件夹函数，移除重名文件的处理（因为目标文件夹已经被清空）
async function copyFolder(sourcePath, targetPath, event, copiedSoFar, totalFiles) {
  try {
    const files = await getAllFiles(sourcePath);
    let copiedFiles = 0;
    let errors = [];

    await fs.mkdir(targetPath, { recursive: true });

    for (const file of files) {
      try {
        const targetFilePath = path.join(targetPath, file.name);
        await fs.copyFile(file.path, targetFilePath);

        copiedFiles++;
        const totalProgress = Math.floor(((copiedSoFar + copiedFiles) / totalFiles) * 100);
        
        event.reply('copy-progress', {
          progress: totalProgress,
          currentFile: file.name,
          totalFiles: totalFiles,
          copiedFiles: copiedSoFar + copiedFiles
        });
      } catch (err) {
        errors.push(`复制文件 ${file.name} 失败: ${err.message}`);
      }
    }

    if (errors.length > 0) {
      event.reply('copy-error', errors.join('\n'));
    } else if (copiedSoFar + copiedFiles === totalFiles) {
      event.reply('copy-complete', {
        totalFiles,
        copiedFiles: copiedSoFar + copiedFiles
      });
    }
  } catch (err) {
    event.reply('copy-error', err.message);
  }
}