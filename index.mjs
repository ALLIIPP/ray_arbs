import dotenv from "dotenv";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  Transaction,
  PublicKey,
  VersionedTransaction,
  sendAndConfirmTransaction,
  TransactionMessage,
  AddressLookupTableProgram
} from "@solana/web3.js";
import got from "got";
import { web3 } from "@project-serum/anchor";
import promiseRetry from "promise-retry";
import {
  TOKEN_PROGRAM_ID,

} from "@solana/spl-token";

import {
  readFileSync,
  writeFileSync
} from 'fs';

import {
  Percent,
  Token,
  TokenAmount,
  Liquidity,
  jsonInfo2PoolKeys,
  LIQUIDITY_STATE_LAYOUT_V4,
  SPL_ACCOUNT_LAYOUT,

} from '@raydium-io/raydium-sdk'
import {
  Market,
  OpenOrders
} from '@project-serum/serum'


dotenv.config();

//wallet
const wallet = (
  Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY))//your wallet
);

const USDC_MINT_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const SLEEP_TIME = 600; // make larger if you get 429`ed

const rpc_list = [
  //put all your rpcs here 
]

let i = 0;


//get route for swap
const getCoinQuote = (inputMint, outputMint, amount) =>
  got
    .get(
      `https://quote-api.jup.ag/v1/quote?outputMint=${outputMint}&inputMint=${inputMint}&amount=${amount}&slippageBps=20`
    )
    .json();

//returns market price for given address
const getSwapPrice = (mintAddress) => {
  return got
    .get(
      `https://price.jup.ag/v1/price?id=${mintAddress}`
    )
    .json();
}

//get unsigned transaction for swap 
const getTransaction = (route) => {
  return got
    .post("https://quote-api.jup.ag/v1/swap", {
      json: {
        route: route,
        userPublicKey: wallet.publicKey.toString(),
        // to make sure it doesnt close the sol account
        wrapUnwrapSOL: false,
      },
    })
    .json();
};


async function arb(info, atas) {

  /*
      info = {
                id,
                baseMint,
                quoteMint,
                lpMint,
                baseDecimals,
                quoteDecimals,
                lpDecimals,
                version,
                programId,
                authority,
                openOrders,
                targetOrders,
                baseVault,
                quoteVault,
                withdrawQueue,
                lpVault,
                marketVersion,
                marketProgramId,
                marketId,
                marketAuthority,
                marketBaseVault,
                marketQuoteVault,
                marketBids,
                marketAsks,
                marketEventQueue,
            };
  */




  let blockhash = await getConnection()
    .getLatestBlockhash()
    .then((res) => res.blockhash);



  let order;
  try {
    order = await getSwapOut(info.baseMint, info.id, info.marketProgramId);
  } catch (e) {
    console.log(e)
    return;
  }


  if (order.in_Amount <= 1 || isNaN(order.in_Amount)) {
    console.log('no dice')
    console.log('/////////////////////////////////////////')
    return;
  }
  console.log(order)



  let jup_order;
  let ray_order;
  if (order.side == 'RAY->JUP') {

    ray_order = await getRaydiumTx(
      {
        tokenIn: info.quoteMint,
        tokenInAmount: order.in_Amount,
        tokenInDecimals: info.quoteDecimals,
        tokenOut: info.baseMint,
        tokenOutDecimals: info.baseDecimals
      }
      , info, atas);

    jup_order = await getCoinQuote(
      info.baseMint,
      info.quoteMint,
      Math.floor(ray_order.amountOut * .99999)
    ).catch((e) => {
      console.log('aaaaaaaaaaaaaa   ' + e)
    })

    let returns = jup_order.data[0].outAmount - order.in_Amount;
    if (returns < 0) {
      console.log('no dice, returns ->    ' + returns)
      console.log('/////////////////////////////////////////')
      return;
    } else {
      console.log('HIT : ' + returns);
    }


  } else {

    jup_order = await getCoinQuote(
      info.quoteMint,
      info.baseMint,
      order.in_Amount
    ).catch((e) => {
      console.log('aaaaaaaaaaaaaa   ' + e)
    })


    ray_order = await getRaydiumTx({
      tokenIn: info.baseMint,
      tokenInAmount: Math.floor(jup_order.data[0].outAmount * .99999),
      tokenInDecimals: info.baseDecimals,
      tokenOut: info.quoteMint,
      tokenOutDecimals: info.quoteDecimals
    }, info, atas)

    let returns = ray_order.amountOut - order.in_Amount;
    if (returns < 0) {
      console.log('no dice, returns ->    ' + returns)
      console.log('/////////////////////////////////////////')
      return;
    } else {
      console.log('HIT : ' + returns);
    }

  }


  let instructions = []
  let signers = []
  try {
    await Promise.all(
      [jup_order.data[0]].map(async (route) => {
        const { setupTransaction, swapTransaction, cleanupTransaction } =
          await getTransaction(route).catch(e => {

            console.log('getTransaction failure : ' + e)
          });

        await Promise.all(
          [setupTransaction, swapTransaction, cleanupTransaction]
            .filter(Boolean)
            .map(async (serializedTransaction) => {


              let transaction = Transaction.from(
                Buffer.from(serializedTransaction, "base64")
              );
              try {
                instructions.push(...transaction.instructions)
                if (transaction.signers) {
                  if (transaction.signers.length > 0) {
                    signers.push(...transaction.signers)
                  }
                }
              } catch (err) {
                console.log(err)
              }
            })
        );
      })
    );
  } catch (e) {
    return
  }


  for (let i = 0; i < instructions.length; i++) {
    try {

      let ook = new PublicKey(instructions[i].programId);

      if (ook.toString() == 'ComputeBudget111111111111111111111111111111') {
        instructions.splice(i, 1);
      }

    } catch (e) {
      console.log('broke    ' + e)
    }
  }


  if (order.side == 'RAY->JUP') {
    instructions = [...ray_order.transaction.instructions, ...instructions];
  } else {
    instructions = [...instructions, ...ray_order.transaction.instructions];
  }


  try {

    let messageV00 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    let transaction = new VersionedTransaction(messageV00);

    transaction.sign([wallet])


    getConnection().sendTransaction(transaction, { skipPreflight: true })
      .catch(e => {
        console.log('send txn err : ' + e)
      })

  } catch (err) {
    console.log('swap failed ' + err)

  }





}



async function begin() {

  let our_markets = await getOurMarkets() // need poolInfo AND ATAs


  console.log("our markets length : " + our_markets.length)

  while (true) {

    for (let market of our_markets) {
      await sleep(SLEEP_TIME);
      arb(market.pool, market.atas)

    }
  }
}
begin()


async function getOurMarkets() {//returns list of {poolInfo, atas:[]} 
  let markets = JSON.parse(readFileSync('raydium.json'));
  let workable = JSON.parse(readFileSync('workable.json'))
  let temp_pools = [...markets.official, ...markets.unOfficial]

  let pools = []

  for (let work of workable.workable) {
    for (let market of temp_pools) {
      if (work == market.id) {
        pools.push(market)
      }
    }
  }

  const tokenResp = await getConnection().getTokenAccountsByOwner(
    wallet.publicKey,
    {
      programId: TOKEN_PROGRAM_ID
    },
  );
  const accounts = [];

  for (const { pubkey, account } of tokenResp.value) {
    accounts.push({
      pubkey,
      accountInfo: SPL_ACCOUNT_LAYOUT.decode(account.data)
    });

  }

  let usdc_account;
  for (let element of accounts) {
    if (element.accountInfo.mint.toString() == USDC_MINT_ADDRESS) {
      usdc_account = element;
      break;
    }
  }



  let our_markets = [];
  for (let account of accounts) {
    for (let pool of pools) {
      if (account.accountInfo.mint.toString() == pool.baseMint) {
        our_markets.push(
          {
            atas: [usdc_account, account], //TODO: dont think order matters here
            pool
          }
        )
        break;
      }
    }
  }


  return our_markets;


}


function getConnection() {

  let connection = new Connection(rpc_list[i % rpc_list.length])
  i++
  return connection
}



async function getRaydiumTx(order, info, tokenAccounts) {
  /*
    tokenIn,
    tokenInAmount,
    tokenInDecimals,
    tokenOut,
    tokenOutDecimals
  */

  const {
    id,
    baseMint,
    quoteMint,
    lpMint,
    baseDecimals,
    quoteDecimals,
    lpDecimals,
    version,
    programId,
    authority,
    openOrders,
    targetOrders,
    baseVault,
    quoteVault,
    withdrawQueue,
    lpVault,
    marketVersion,
    marketProgramId,
    marketId,
    marketAuthority,
    marketBaseVault,
    marketQuoteVault,
    marketBids,
    marketAsks,
    marketEventQueue,
  } = jsonInfo2PoolKeys(info)
  const poolKeys = {
    id,
    baseMint,
    quoteMint,
    lpMint,
    baseDecimals,
    quoteDecimals,
    lpDecimals,
    version,
    programId,
    authority,
    openOrders,
    targetOrders,
    baseVault,
    quoteVault,
    withdrawQueue,
    lpVault,
    marketVersion,
    marketProgramId,
    marketId,
    marketAuthority,
    marketBaseVault,
    marketQuoteVault,
    marketBids,
    marketAsks,
    marketEventQueue,
  };

  const poolInfo = await Liquidity.fetchInfo(
    {
      connection: getConnection(),
      poolKeys
    }
  );


  const amountIn = new TokenAmount(new Token(new web3.PublicKey(order.tokenIn), order.tokenInDecimals), order.tokenInAmount, true) //raw number 

  const currencyOut = new Token(new web3.PublicKey(order.tokenOut), order.tokenOutDecimals)

  const slippage = new Percent(5, 100);

  const {
    amountOut,
    minAmountOut,
    currentPrice,
    executionPrice,
    priceImpact,
    fee,
  } = Liquidity.computeAmountOut({ poolKeys, poolInfo, amountIn, currencyOut, slippage, })


  const { transaction, signers } = await Liquidity.makeSwapTransaction({
    connection: getConnection(),
    poolKeys,
    userKeys: {
      tokenAccounts,
      owner: wallet.publicKey,
    },
    amountIn,
    amountOut: amountOut,
    fixedSide: "in"
  }).catch((e) => {
    console.log('wgrsgfgf : ' + e)
  })


  let output = Math.floor(amountOut.toFixed() * (10 ** order.tokenOutDecimals))



  return { transaction, amountOut: output };

}



async function getSwapOut(baseMint, pool, marketProgramId) {
  console.log('poolid : ' + pool)
  console.log('marketProgramId : ' + marketProgramId)
  const poolId = new web3.PublicKey(pool);
  const info = await getConnection().getAccountInfo(poolId);
  const state = LIQUIDITY_STATE_LAYOUT_V4.decode(info.data);

  const baseTokenAmount = await getConnection().getTokenAccountBalance(state.baseVault);
  const quoteTokenAmount = await getConnection().getTokenAccountBalance(state.quoteVault);


  const openOrders = await OpenOrders.load(getConnection(), state.openOrders, new web3.PublicKey(marketProgramId));

  const baseDecimal = 10 ** state.baseDecimal.toNumber()
  const quoteDecimal = 10 ** state.quoteDecimal.toNumber()

  const openOrdersTotalBase = openOrders.baseTokenTotal.toNumber() / baseDecimal
  const openOrdersTotalQuote = openOrders.quoteTokenTotal.toNumber() / quoteDecimal

  const basePnl = state.baseNeedTakePnl.toNumber() / baseDecimal
  const quotePnl = state.quoteNeedTakePnl.toNumber() / quoteDecimal


  const base = baseTokenAmount.value?.uiAmount + openOrdersTotalBase - basePnl


  const quote = quoteTokenAmount.value?.uiAmount + openOrdersTotalQuote - quotePnl

  // TODO 0.25% goe to raydium
  let price = quote / base;





  let marketPrice = await getSwapPrice(new web3.PublicKey(baseMint))

  /*
  if (marketPrice.data.price) {
    let thing = JSON.parse(readFileSync('workable.json'))
    thing.workable.push(pool);
    writeFileSync('workable.json', JSON.stringify(thing))
  } else {
    console.log('aaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    return;
  }
*/


  let k = base * quote;
  let new_base = Math.sqrt(k / marketPrice.data.price)
  //let new_quote = (k / new_base);

  let in_Amount = Math.floor(Math.abs(quote - (k / new_base)) * quoteDecimal);

  in_Amount = Math.floor(in_Amount * 0.4)



  /*
    console.log("market price : " + marketPrice.data.price);
    console.log('pool price : ' + price)
  
    console.log('////////////////////////////////////////////')
    console.log('base : ' + base)
    console.log('quote : ' + quote)
    console.log('k : ' + k)
  
    console.log('new_base : ' + new_base)
    console.log('new quote : ' + new_quote)
    console.log('USDC CHANGE  : ' + in_Amount)
  
    console.log('////////////////////////////////////////////')
  */
  return {
    side: price > marketPrice.data.price ? "RAY->JUP" : "JUP->RAY",
    in_Amount,
  }

}

