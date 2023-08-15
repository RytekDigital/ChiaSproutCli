const fs = require("fs-extra");
const path = require("path");
const changeListGenerator = require("chia-changelist-generator");
const wallet = require("./rpcs/wallet");
const { encodeHex } = require("./utils/hex-utils");
const Datalayer = require("chia-datalayer");
const { getChiaConfig } = require("chia-config-loader");
const {
  getConfig,
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
} = require("./utils/config-loader");
const { logInfo, logError } = require("./utils/console-tools");

async function deployHandler() {
  try {
    const config = getConfig();

    if (config.store_id === null) {
      logError(
        "A store_id is not defined in sprout.config.json. Please run 'create-store' command to create a new store."
      );
      return;
    }

    if (!(await wallet.walletIsSynced())) {
      logError(
        "The wallet is not synced. Please wait for it to sync and try again."
      );
      return;
    }

    if (!fs.existsSync(config.deploy_dir)) {
      logError(
        `The directory "${config.deploy_dir}" specified in sprout.config.json does not exist. Please specify a valid directory.`
      );
      return;
    }

    changeListGenerator.configure(config);

    const fileList = await walkDirAndCreateFileList(
      config.deploy_dir,
      config.store_id
    );

    const chunkedChangelist = await changeListGenerator.generateChangeList(
      config.store_id,
      "insert",
      fileList,
      { chunkChangeList: true }
    );

    logInfo(
      `Pushing files to datalayer in ${chunkedChangelist.length} transaction(s).`
    );

    if (chunkedChangelist.length > 1) {
      logInfo(
        "There are multiple transactions due to the size of the changelist, this operation may take a while to complete."
      );
    }

    let chunkCounter = 1;

    const datalayer = Datalayer.rpc(config);

    // Send each chunk in separate transactions
    for (const chunk of chunkedChangelist) {
      logInfo(
        `Sending chunk #${chunkCounter} of ${
          chunkedChangelist.length
        } to datalayer. Size ${Buffer.byteLength(
          JSON.stringify(chunk),
          "utf-8"
        )}`
      );

      await datalayer.updateDataStore({
        id: config.store_id,
        changelist: chunk,
      });

      chunkCounter++;
    }

    logInfo("Deploy operation completed successfully.");
  } catch (error) {
    logError(error.message);
  } finally {
    process.exit();
  }
}

function initHandler() {
  try {
    if (fs.existsSync(CONFIG_FILENAME)) {
      logInfo(
        "A sprout.config.json file already exists in the current directory."
      );
    } else {
      fs.writeJsonSync(CONFIG_FILENAME, DEFAULT_CONFIG, { spaces: 2 });
      logInfo(
        "A new sprout.config.json file has been created with the default configuration."
      );
    }
  } catch (error) {
    logError(error.message);
  } finally {
    process.exit();
  }
}

async function mirrorStoreHandler() {
  try {
    const { publicIpv4 } = require("./utils/ip-utils");
    const ip = await publicIpv4();

    const config = getConfig();
    const datalayer = Datalayer.rpc(config);

    if (!config.store_id) {
      logError("No store_id specified in sprout.config.json");
      return;
    }

    if (!(await wallet.walletIsSynced())) {
      logError("The wallet is not synced. Please sync and try again.");
      return;
    }

    if (!ip) {
      logError("Could not determine public IP address");
      return;
    }

    const chiaConfig = getChiaConfig();

    const port = chiaConfig.data_layer.host_port;

    const url = `http://${ip}:${port}`;

    logInfo(`Adding mirror ${url} to store ${config.store_id}`);

    const response = await datalayer.addMirror({
      id: config.store_id,
      urls: [url],
      amount: config.default_mirror_coin_amount,
    });

    if (!response.success) {
      logError("Failed to add mirror");
      return;
    }

    logInfo("Mirror added successfully");
  } catch (error) {
    logError(error.message);
  } finally {
    process.exit();
  }
}

async function createStoreHandler(isNew = false) {
  try {
    const config = getConfig();

    if (!isNew && config.store_id !== null) {
      logError("A store_id already exists in sprout.config.json");
      return;
    }

    if (!(await wallet.walletIsSynced())) {
      logError(
        "The wallet is not synced, please wait for it to sync and try again"
      );
      return;
    }

    logInfo("Creating new store, please wait for the transaction to complete");

    const datalayer = Datalayer.rpc(config);
    const response = await datalayer.createDataStore();

    if (!response.success) {
      logError("Failed to create new store");
      return;
    }

    const storeId = response.id;

    fs.writeJsonSync(
      CONFIG_FILENAME,
      { ...config, store_id: storeId },
      { spaces: 2 }
    );
    logInfo(`Created new store with id ${storeId}`);
  } catch (error) {
    logError(error.message);
  } finally {
    process.exit();
  }
}

async function cleanStoreHandler() {
  try {
    const config = getConfig();

    if (config.store_id === null) {
      logError("No store_id specified in sprout.config.json");
      return;
    }

    if (!(await wallet.walletIsSynced())) {
      logError("The wallet is not synced. Please sync and try again.");
      return;
    }

    const datalayer = Datalayer.rpc(config);
    changeListGenerator.configure(config);

    const fileList = await datalayer.getKeys({ id: config.store_id });

    const chunkedChangelist = await changeListGenerator.generateChangeList(
      config.store_id,
      "delete",
      fileList.keys.map((key) => ({ key })),
      { chunkChangeList: true }
    );

    logInfo(
      `Deleting items from datalayer in ${chunkedChangelist.length} transaction(s).`
    );

    for (const chunk of chunkedChangelist) {
      await datalayer.updateDataStore({
        id: config.store_id,
        changelist: chunk,
      });
    }

    logInfo("Done deleting items from store.");
  } catch (error) {
    logError(error.message);
  } finally {
    process.exit();
  }
}

async function walkDirAndCreateFileList(
  dirPath,
  storeId,
  existingKeys,
  rootDir = dirPath
) {
  const files = fs.readdirSync(dirPath);

  let fileList = [];

  for (const file of files) {
    const filePath = path.join(dirPath, file);

    if (fs.statSync(filePath).isDirectory()) {
      const subdirChangeList = await walkDirAndCreateFileList(
        filePath,
        storeId,
        existingKeys,
        rootDir
      );
      fileList.push(...subdirChangeList);
    } else {
      const relativeFilePath = path.relative(rootDir, filePath);
      const contentBuffer = fs.readFileSync(filePath);
      const content = contentBuffer.toString("hex");

      fileList.push({
        key: encodeHex(relativeFilePath.replace(/\\/g, "/")),
        value: content,
      });
    }
  }

  return fileList;
}

module.exports = {
  deployHandler,
  initHandler,
  createStoreHandler,
  cleanStoreHandler,
  mirrorStoreHandler,
};
