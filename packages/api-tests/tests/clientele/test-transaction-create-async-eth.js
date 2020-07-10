const crypto = require('crypto');

const testenv = require('../../testenv.js');
const partials = require('../../partials.js');

const { EthGasStation } = require('../../ethgasstation.js');

const egs = new EthGasStation();

// Shortcuts to most-used facilities.
const { test, inspect, int2BN } = testenv;


let faucet = null;
let faucetConfig;

async function testAsyncTransactionCreationWithFaucet(t) {
  if (! faucet) {
    t.fail('Called testAsyncTransactionCreationWithFaucet() without actual faucet configuration being available.')
    t.end();
    return;
  }

  // Encapsulate in try / finally to be able to disconnect the websocket
  // connection of the faucet. Without disconnecting, the Nodejs process would
  // stay alive beyond test completion.
  try {
    // Allow 0 to turn off waiting for balance updates.
    const BALANCE_UPDATE_WAIT_MINUTES = (typeof faucetConfig.balanceUpdateWaitMinutes == 'number') ? faucetConfig.balanceUpdateWaitMinutes : 4;

    const { username, password } = await partials.tCreateUser(t, testenv.tenancy);
    if (! username) return;
    inspect('User credentials, in case the faucetting and/or test Tx fails:', {username, password});

    const clientele = testenv.getClienteleAPI(username, password);

    const assetIds = [
      faucetConfig.eth.assetId,
    ];
    const createdWallets = await partials.tCreateWallets(t, clientele, assetIds, username, password);

    t.comment('Generate transactions for those wallets which are Ethereum or Erc20 wallets.')
    for await (const wallet of clientele.wallets.list()) {
      let currentEthBalanceAmount;

      // Only test Tx creation for ETH and ERC20.
      const protocolNamesToTestTxWith = [
        'ethereum', 'erc20',
        'ethereum_ropsten', 'erc20_ropsten',
        'ethereum_kovan', 'erc20_kovan',
      ];
      if (!protocolNamesToTestTxWith.includes(wallet.protocol)) {
        continue;
      }

      t.comment('Inspecting listed wallet:');
      t.comment(testenv.getAddressEtherscanUrl(wallet.protocol, wallet.address));
      inspect(wallet);
      let ethBalance = testenv.getBalanceForAssetId(wallet, faucetConfig.eth.assetId);
      if (ethBalance) {
        currentEthBalanceAmount = ethBalance.amount;
      }

      t.ok(int2BN(currentEthBalanceAmount).eq(int2BN(0)), 'Initial ETH Balance is 0');

      t.comment(`Creating a transaction in the async workflow.`);

      const fee = int2BN((await egs.getGasPrice(24)).min).mul(int2BN(21000));

      t.comment('Faucet some ETH to the new wallet.');
      let faucetResult;
      try {
        faucetResult = await faucet.faucetEth(wallet.address, int2BN(faucetConfig.eth.amount).add(fee), t.comment);
      }
      catch (err) {
        return partials.tErrorFail(t, err, `Faucetting some ETH to the new wallet failed.`);
      }
      t.comment(testenv.getTxEtherscanUrl(wallet.protocol, faucetResult.transactionHash));
      inspect('Faucet result:', faucetResult);

      if (BALANCE_UPDATE_WAIT_MINUTES) {
        currentEthBalanceAmount = await partials.tWaitForBalanceUpdate(t, clientele, wallet.id, faucetConfig.eth.assetId, currentEthBalanceAmount, BALANCE_UPDATE_WAIT_MINUTES);
        t.ok(int2BN(currentEthBalanceAmount).eq(int2BN(faucetConfig.eth.amount).add(fee)), `ETH Balance now equals faucet amount plus fee.`);
      }

      t.comment(`Set up webhook listener, might take a while.`);
      const webhookRecording = await testenv.getWebhookRecording();

      t.comment(`Create ETH-only transaction, with external gas funding.`);
      let txResult;
      try {
        txResult = await clientele.transactions.create(
          wallet.id,
          password,
          faucetConfig.holder.address,
          faucetConfig.eth.assetId,
          int2BN(faucetConfig.eth.amount).toString(10),
          fee.toString(10),
          true,
        );
      }
      catch (err) {
        return partials.tErrorFail(t, err, `Creating ETH-only transaction failed.`);
      }

      t.comment(`Inspecting result of ETH-only transaction creation:`);
      t.comment(testenv.getTxEtherscanUrl(wallet.protocol, txResult.txhash));
      inspect(txResult);

      webhookRecording.addMatcher((body, simpleHeaders, rawHeaders, metaData) => {
        const webhookPayload = JSON.parse(body);

        if (webhookPayload.data.id != txResult.id) {
          // This is not the webhook this matcher is looking for.
          return false;
        }

        t.equal(webhookPayload.action, 'transaction.processed', 'Webhook action is "transaction.processed"');

        const signatureHeader = simpleHeaders['X-Up-Signature'];
        t.ok(signatureHeader, 'Found webhook HMAC signature header');
        const hmac = crypto.createHmac('sha256', testenv.config.webhook.hmacKey).update(body, 'utf8').digest('hex');
        t.equal(signatureHeader, 'sha256=' + hmac, 'Webhook HMAC signature matches');

        t.notEqual(webhookPayload.data.hash.length, 0, `Received webhook with transaction hash ${webhookPayload.data.hash}.`);
        t.comment(testenv.getTxEtherscanUrl(wallet.protocol, webhookPayload.data.hash));
        t.notEqual(webhookPayload.data.status, "QUEUED", `Received webhook with transaction status not "QUEUED" anymore.`);

        return true;
      });

      try {
        t.comment('Waiting for all expected webhooks to be called.')
        const areAllExpectedWebhooksCalled = await webhookRecording.areAllMatched(3 * 60 * 1000);
        t.ok(areAllExpectedWebhooksCalled, 'All expected webhooks were called');
      }
      catch (err) {
        inspect(err);
        t.fail('Timed out while waiting for all expected webhooks to be called');
      }

      webhookRecording.stop();

      const tx = await clientele.transactions.retrieve(wallet.id, txResult.id);
      t.comment(`Inspecting retrieved TX:`);
      inspect(tx);

      if (BALANCE_UPDATE_WAIT_MINUTES) {
        currentEthBalanceAmount = await partials.tWaitForBalanceUpdate(t, clientele, wallet.id, faucetConfig.eth.assetId, currentEthBalanceAmount, BALANCE_UPDATE_WAIT_MINUTES);
        t.ok(int2BN(currentEthBalanceAmount).eq(int2BN(0)), `ETH Balance now back to zero.`);
      }
    }

  }
  finally {
    if (faucet) {
      faucet.disconnect();
    }
    t.end();
  }
}



if (('faucet' in testenv.config) && ('ethereum' in testenv.config.faucet)) {
  faucetConfig = testenv.config.faucet.ethereum;
  faucet = new testenv.EthereumAndErc20Faucet(faucetConfig);
  test('Testing async ETH transactions.create() with faucet', testAsyncTransactionCreationWithFaucet);
}
else {
  test('Skip testing async ETH transactions.create() *without* faucet', async t => t.end());
}