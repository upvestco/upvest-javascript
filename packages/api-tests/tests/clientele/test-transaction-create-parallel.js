const testenv = require('../../testenv.js');
const partials = require('../../partials.js');

// Shortcuts to most-used facilities.
const { test, inspect, int2BN } = testenv;


let faucet = null;
let faucetConfig;

async function testParallelTransactionsWithFaucet(t) {
  if (! faucet) {
    t.fail('Called testParallelTransactionsWithFaucet() without actual faucet configuration being available.')
    t.end();
    return;
  }

  // Encapsulate in try / finally to be able to disconnect the websocket
  // connection of the faucet. Without disconnecting, the Nodejs process would
  // stay alive beyond test completion.
  try {
    // Allow 0 to turn off waiting for balance updates.
    const BALANCE_UPDATE_WAIT_MINUTES = (typeof faucetConfig.balanceUpdateWaitMinutes == 'number') ? faucetConfig.balanceUpdateWaitMinutes : 4;

    const PARALLEL = testenv.parallel;

    const { username, password } = await partials.tCreateUser(t, testenv.tenancy);
    if (! username) return;
    inspect('User credentials, in case the faucetting and/or test Tx fails:', {username, password});

    const clientele = testenv.getClienteleAPI(username, password);

    const assetIds = [
      faucetConfig.eth.assetId,
      faucetConfig.erc20.assetId,
    ];
    const createdWallets = await partials.tCreateWallets(t, clientele, assetIds, username, password);

    t.comment('Generate transactions for those wallets which are Ethereum or Erc20 wallets.')
    for await (const wallet of clientele.wallets.list()) {
      let fee;
      let tx;
      let currentEthBalanceAmount;
      let currentErc20BalanceAmount;
      let faucetResults;

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
      let erc20balance = testenv.getBalanceForAssetId(wallet, faucetConfig.erc20.assetId);
      if (erc20balance) {
        currentErc20BalanceAmount = erc20balance.amount;
      }

      t.ok(int2BN(currentEthBalanceAmount).eq(int2BN(0)), 'Initial ETH Balance is 0');
      t.ok(int2BN(currentErc20BalanceAmount).eq(int2BN(0)), 'Initial ERC20 Balance is 0');


      t.comment(`Creating ${PARALLEL} transactions in parallel.`);

      t.comment('Faucet *only* ERC20 tokens to the new wallet. This is done to trigger an auxilliary service, which will cover the gas cost.');
      faucetResults = await faucet.run(wallet.address, int2BN(0), int2BN(faucetConfig.erc20.amount).mul(int2BN(PARALLEL)), t.comment);
      for (const faucetResult of faucetResults) {
        t.comment(testenv.getTxEtherscanUrl(wallet.protocol, faucetResult.transactionHash));
      }
      inspect('Faucet results:', faucetResults);

      if (BALANCE_UPDATE_WAIT_MINUTES) {
        currentErc20BalanceAmount = await partials.tWaitForBalanceUpdate(t, clientele, wallet.id, faucetConfig.erc20.assetId, currentErc20BalanceAmount, BALANCE_UPDATE_WAIT_MINUTES);
        t.ok(int2BN(currentErc20BalanceAmount).eq(int2BN(faucetConfig.erc20.amount).mul(int2BN(PARALLEL))), `ERC20 Balance now equals faucet amount times ${PARALLEL}, for ${PARALLEL} parallel transactions.`);
      }

      t.comment(`Create ${PARALLEL} parallel ERC20-only transactions, with external gas funding.`);

      const erc20onlyCreate = async () => {
        return await clientele.transactions.create(
          wallet.id,
          password,
          recipient=faucetConfig.holder.address,
          assetId=faucetConfig.erc20.assetId,
          quantity=int2BN(faucetConfig.erc20.amount).toString(10),
          fee=int2BN(faucetConfig.gasPrice).mul(int2BN(21000).add(int2BN(faucetConfig.erc20.gasLimit))).toString(10)
        );
      }

      const erc20onlyPromises = [];
      for (let i = 0; i < PARALLEL; i++) {
        erc20onlyPromises.push(erc20onlyCreate());
      }

      inspect(erc20onlyPromises);

      let results = [];
      try {
        results = await Promise.all(erc20onlyPromises);
      }
      catch (firstErr) {
        return partials.tErrorFail(t, firstErr, `Creating (at least) one of the ${PARALLEL} parallel ERC20-only transactions failed.`);
      }

      t.comment(`Inspecting results of ${PARALLEL} parallel ERC20-only transaction creations:`);
      for (const tx of results) {
        t.comment(testenv.getTxEtherscanUrl(wallet.protocol, tx.txhash));
        inspect(tx);
      }

      // // We have to keep track here because potentially, the external gas funding might have left some "dust".
      // // But we can not assert any specific value for that "dust", it could even be "0 dust".
      // if (BALANCE_UPDATE_WAIT_MINUTES) {
      //   currentEthBalanceAmount = await partials.tWaitForBalanceUpdate(t, clientele, wallet.id, faucetConfig.eth.assetId, currentEthBalanceAmount, BALANCE_UPDATE_WAIT_MINUTES);
      //   inspect(`ETH Balance after ERC20 Tx with external gas funding (i.e. "dust") == ${currentEthBalanceAmount}`);
      // 
      //   currentErc20BalanceAmount = await partials.tWaitForBalanceUpdate(t, clientele, wallet.id, faucetConfig.erc20.assetId, currentErc20BalanceAmount, BALANCE_UPDATE_WAIT_MINUTES);
      //   t.ok(int2BN(currentErc20BalanceAmount).eq(int2BN(0)), 'ERC20 Balance now back to 0');
      //   // inspect(`ERC20 Balance after ERC20 Tx == ${currentErc20BalanceAmount}`);
      // }
      // 
      // const preEthFaucetEthBalanceAmount = currentEthBalanceAmount;
      // t.comment(`Faucet some ETH and some ERC20 tokens to the new wallet.`);
      // 
      // // It can happen that our faucet is the same sender as the "auxilliary gas funding service".
      // // In this case we have to re-sync nonces to account for that "auxilliary" transaction.
      // // const inbetweenNonce = await faucet.getNonce();
      // // inspect(`inbetweenNonce == ${inbetweenNonce.toString(10)}`)
      // // const blockchainNonce = await faucet.getInitialNonce();
      // // inspect(`blockchainNonce == ${blockchainNonce.toString(10)}`)
      // 
      // const totalGasLimit = (
      //   int2BN(21000)  // gas limit for the plain ETH transaction
      //   .add(
      //     int2BN(21000)  // base-line gas limit for ERC20 transaction (the gas you pay to trigger a transaction at all, sans running byte code)
      //   ).add(
      //     int2BN(faucetConfig.erc20.gasLimit)  // gas limit to run the EVM byte code for the actual ERC20 transaction
      //   )
      // );
      // 
      // const totalEthFaucetAmount = (
      //   int2BN(faucetConfig.gasPrice).mul(int2BN(totalGasLimit))
      //   .add(
      //     int2BN(faucetConfig.eth.amount)
      //   )
      // );
      // 
      // faucetResults = await faucet.run(wallet.address, totalEthFaucetAmount, int2BN(faucetConfig.erc20.amount), t.comment);
      // for (const faucetResult of faucetResults) {
      //   t.comment(testenv.getTxEtherscanUrl(wallet.protocol, faucetResult.transactionHash));
      // }
      // inspect('Faucet results:', faucetResults);
      // faucet.disconnect();
      // 
      // if (BALANCE_UPDATE_WAIT_MINUTES) {
      //   currentEthBalanceAmount = await partials.tWaitForBalanceUpdate(t, clientele, wallet.id, faucetConfig.eth.assetId, currentEthBalanceAmount, BALANCE_UPDATE_WAIT_MINUTES);
      //   t.comment('See if ETH Balance did increase by faucet amount');
      //   inspect({
      //     preEthFaucetEthBalanceAmount,
      //     currentEthBalanceAmount,
      //     increasedBy: int2BN(currentEthBalanceAmount).sub(int2BN(preEthFaucetEthBalanceAmount)).toString(10),
      //     totalEthFaucetAmount: totalEthFaucetAmount.toString(10),
      //   });
      //   // // Deactivated for now because gas funding is not precise.
      //   // // TODO Get "second opinion" from other blockchain service, to compare with.
      //   // t.ok(int2BN(currentEthBalanceAmount).sub(int2BN(preEthFaucetEthBalanceAmount)).eq(totalEthFaucetAmount), 'ETH Balance did increase by faucet amount');
      // 
      //   currentErc20BalanceAmount = await partials.tWaitForBalanceUpdate(t, clientele, wallet.id, faucetConfig.erc20.assetId, currentErc20BalanceAmount, BALANCE_UPDATE_WAIT_MINUTES);
      //   t.ok(int2BN(currentErc20BalanceAmount).eq(int2BN(faucetConfig.erc20.amount)), 'ERC20 Balance now equals faucet amount');
      // }
      // 
      // const preEthTxEthBalanceAmount = currentEthBalanceAmount;
      // t.comment('Create ETH transaction with user gas funding.');
      // const ethTxAmount = int2BN(faucetConfig.eth.amount);
      // const ethTxFee = int2BN(faucetConfig.gasPrice).mul(int2BN(21000));
      // try {
      //   tx = await clientele.transactions.create(
      //     wallet.id,
      //     password,
      //     recipient=faucetConfig.holder.address,
      //     assetId=faucetConfig.eth.assetId,
      //     quantity=ethTxAmount.toString(10),
      //     fee=ethTxFee.toString(10)
      //   );
      // }
      // catch (error) {
      //   return partials.tErrorFail(t, error, 'Creating the ETH transaction failed.');
      // }
      // t.comment('Inspecting result of ETH transaction creation:');
      // t.comment(testenv.getTxEtherscanUrl(wallet.protocol, tx.txhash));
      // inspect(tx);
      // 
      // if (BALANCE_UPDATE_WAIT_MINUTES) {
      //   currentEthBalanceAmount = await partials.tWaitForBalanceUpdate(t, clientele, wallet.id, faucetConfig.eth.assetId, currentEthBalanceAmount, BALANCE_UPDATE_WAIT_MINUTES);
      //   t.comment('See if ETH Balance did decrease by tx amount & fee');
      //   inspect({
      //     preEthTxEthBalanceAmount,
      //     currentEthBalanceAmount,
      //     decreasedBy: int2BN(currentEthBalanceAmount).sub(int2BN(preEthFaucetEthBalanceAmount)).toString(10),
      //     ethTxAmount: ethTxAmount.toString(10),
      //     ethTxFee: ethTxFee.toString(10),
      //     "ethTx(Amount+Fee)": ethTxAmount.add(ethTxFee).toString(10),
      //   });
      //   // // Deactivated for now because gas funding is not precise.
      //   // // TODO Get "second opinion" from other blockchain service, to compare with.
      //   // t.ok(int2BN(currentEthBalanceAmount).sub(int2BN(preEthTxEthBalanceAmount)).eq(ethTxAmount.add(ethTxFee)), 'ETH Balance did decrease by tx amount & fee');
      // }
      // 
      // t.comment('Create ERC20 transaction with user gas funding.');
      // try {
      //   tx = await clientele.transactions.create(
      //     wallet.id,
      //     password,
      //     recipient=faucetConfig.holder.address,
      //     assetId=faucetConfig.erc20.assetId,
      //     quantity=int2BN(faucetConfig.erc20.amount).toString(10),
      //     fee=int2BN(faucetConfig.gasPrice).mul(int2BN(21000).add(int2BN(faucetConfig.erc20.gasLimit))).toString(10)
      //   );
      // }
      // catch (error) {
      //   return partials.tErrorFail(t, error, 'Creating the ERC20 transaction failed.');
      // }
      // t.comment('Inspecting result of ERC20 transaction creation:');
      // t.comment(testenv.getTxEtherscanUrl(wallet.protocol, tx.txhash));
      // inspect(tx);
      // 
      // if (BALANCE_UPDATE_WAIT_MINUTES) {
      //   // TODO check if ETH Balance decreased by fee of ERC20 tx.
      // 
      //   currentErc20BalanceAmount = await partials.tWaitForBalanceUpdate(t, clientele, wallet.id, faucetConfig.erc20.assetId, currentErc20BalanceAmount, BALANCE_UPDATE_WAIT_MINUTES);
      //   t.ok(int2BN(currentErc20BalanceAmount).eq(int2BN(0)), 'ERC20 Balance now back to 0');
      // }
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
  test('Testing parallel ETH/ERC20 transactions.create() with faucet', testParallelTransactionsWithFaucet);
}
else {
  test('Skip testing parallel ETH/ERC20 transactions.create() *without* faucet', async t => t.end());
}