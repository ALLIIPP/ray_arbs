# Arb BOT using Raydium SDK

This is not 100% risk free 

 
Makes money(USDC) by swapping back and forth between tokens in a single transaction. It checks raydium pools against spot price from Jupiter api and submits arb transaction to rebalance pool if profitable.

You need to create the associated token accounts for all the base currencies you want to trade (as well as USDC) before you start the bot.
 
 
======

## How to use?
1. Install dependencies
```sh
npm install
```

2. create .env file with your priv key

3. put your rpc link/links in variable 'rpc_list' 

4. if your rpc provider rate limits you, change 'SLEEP_TIME'

4. run the file
```sh
node index.mjs
```
