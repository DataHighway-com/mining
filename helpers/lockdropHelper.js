const Promise = require('bluebird');
const { toBN, fromWei, hexToNumber } = require('web3').utils;
const schedule = require('./schedule');
const generalizedLocks = require('./generalizedLocks');
const constants = require("./constants");

// FIXME
function getEffectiveValue(erc20TokenAmount, term, lockTime, lockStart, totalERC20Token) {
  // multiplicative bonus starts at 100 / 100 = 1
  let bonus = toBN(100);
  // get multiplicative bonus if calculating allocation of locks
  if (lockTime && lockStart) {
    bonus = schedule.getEarlyParticipationBonus(lockTime, lockStart);
  }

  const HALF = toBN('1', 10).div(toBN('2', 10)); // 0.5
  let lowestLockBonusMultiplier = toBN(102).add(HALF);
  if (term == '0') {
    // 3 month term yields 102.5% bonus
    return toBN(erc20TokenAmount).mul(lowestLockBonusMultiplier.mul(bonus)).div(toBN(10000));
  } else if (term == '1') {
    // 6 month term yields 105% bonus
    // Note: Use 105/10000 instead of 1.05/100 to generate % since BN.js doesn't support decimals
    return toBN(erc20TokenAmount).mul(toBN(105).mul(bonus)).div(toBN(10000));
  } else if (term == '2') {
    // 9 month term yields 107.5% bonus
    return toBN(erc20TokenAmount).mul(toBN(107).add(HALF).mul(bonus)).div(toBN(10000));
  } else if (term == '3') {
    // 12 month term yields 110% bonus
    return toBN(erc20TokenAmount).mul(toBN(110).mul(bonus)).div(toBN(10000));
  } else if (term == '4') {
    // 24 month term yields 115% bonus
    return toBN(erc20TokenAmount).mul(toBN(115).mul(bonus)).div(toBN(10000));
  } else if (term == '5') {
    // 36 month term yields 120% bonus
    return toBN(erc20TokenAmount).mul(toBN(120).mul(bonus)).div(toBN(10000));
    102.5
  } else if (term == 'signaling') {
    // signalling attracts 10% of lowest locking bonus
    // Note: 100 + ((102.5 - 100) / 10) = 100.25
    const proportionOfLowestLockBonusMultiplier = (toBN(100).add((lowestLockBonusMultiplier.sub(toBN(100))).div(toBN(10))));
    return toBN(erc20TokenAmount).mul(lowestLockBonusMultiplier.mul(bonus)).div(toBN(10000));
  // } else if (term == 'signaling') {
  //   // 80% deduction
    // return toBN(erc20TokenAmount).mul(toBN(20)).div(toBN(100));
  } else {
    // invalid term
    return toBN(0);
  }
}

const getLocks = async (lockdropContract, address) => {
  return await lockdropContract.getPastEvents('Locked', {
    fromBlock: 0,
    toBlock: 'latest',
    filter: {
      owner: address,
    }
  });
};

const getSignals = async (lockdropContract, address) => {
  return await lockdropContract.getPastEvents('Signaled', {
    fromBlock: 0,
    toBlock: 'latest',
    filter: {
      contractAddr: address,
    }
  });
};

const getTotalLockedBalance = async (lockdropContract) => {
  let { totalERC20TokenLocked, totalEffectiveERC20TokenLocked } = await calculateEffectiveLocks(lockdropContract);
  return { totalERC20TokenLocked, totalEffectiveERC20TokenLocked };
};

const getTotalSignaledBalance = async (web3, lockdropContract) => {
  let { totalERC20TokenSignaled, totalEffectiveERC20TokenSignaled } = await calculateEffectiveSignals(web3, lockdropContract);
  return { totalERC20TokenSignaled, totalEffectiveERC20TokenSignaled };
};

const calculateEffectiveLocks = async (lockdropContracts) => {
  let totalERC20TokenLocked = toBN(0);
  let totalEffectiveERC20TokenLocked = toBN(0);
  const locks = {};
  const validatingLocks = {};

  let lockEvents = []
  for (let index in lockdropContracts) {
    let events = await lockdropContracts[index].getPastEvents('Locked', {
      fromBlock: 0,
      toBlock: 'latest',
    });
    lockEvents = [ ...lockEvents, ...events ];
  }

  // For truffle tests
  let lockdropStartTime;
  if (typeof lockdropContracts[0].LOCK_START_TIME === 'function') {
    lockdropStartTime = (await lockdropContracts[0].LOCK_START_TIME());
  } else {
    lockdropStartTime = (await lockdropContracts[0].methods.LOCK_START_TIME().call());
  }
  console.log(`Lock events ${lockEvents.length}`);
  lockEvents.forEach((event) => {
    const data = event.returnValues;
    // allocate locks to first key if multiple submitted or malformed larger key submitted
    // NOTE: if key was less than length of a correct submission (66 chars), funds are considered lost
    let keys = [data.dataHighwayPublicKey];
    // FIXME [calculateEffectiveLocks-1] - why are we reducing the length of the decoded public key (hex) here
    // (that we originally decoded in lockdrop.js using `bs58.decode ...`) by removing 6 characters from the end?
    // because if we do this we can't encode it back again in function `getDataHighwayBalanceObjects` with `bs58.encode ...`
    // and it causes the assertion in the test 'should ensure base58 encodings are valid to submit' to fail.
    // Also why are we encoding with `bs58.encode ...` but then decoding with Polkadot.js's `keyring.encodeAddress(key)`
    // if (data.dataHighwayPublicKey.length >= 66) {
    //   keys = data.dataHighwayPublicKey.slice(2).match(/.{1,64}/g).map(key => `0x${key}`);
    // }
    let value = getEffectiveValue(tokenERC20Amount, data.term, data.time, lockdropStartTime, totalERC20TokenLocked);
    totalERC20TokenLocked = totalERC20TokenLocked.add(toBN(tokenERC20Amount));
    totalEffectiveERC20TokenLocked = totalEffectiveERC20TokenLocked.add(value);

    // Add all validators to a separate collection to do validator election over later
    if (data.isValidator) {
      if (keys[0] in validatingLocks) {
        validatingLocks[keys[0]] = {
          lockAmt: toBN(tokenERC20Amount).add(toBN(validatingLocks[keys[0]].lockAmt)).toString(),
          effectiveValue: toBN(validatingLocks[keys[0]].effectiveValue).add(value).toString(),
          lockAddrs: [data.lockAddr, ...validatingLocks[keys[0]].lockAddrs],
        };
      } else {
        validatingLocks[keys[0]] = {
          lockAmt: toBN(tokenERC20Amount).toString(),
          effectiveValue: value.toString(),
          lockAddrs: [data.lockAddr],
        };
      }
    }


    // Add all locks to collection, calculating/updating effective value of lock
    if (keys[0] in locks) {
      locks[keys[0]] = {
        lockAmt: toBN(tokenERC20Amount).add(toBN(locks[keys[0]].lockAmt)).toString(),
        effectiveValue: toBN(locks[keys[0]].effectiveValue).add(value).toString(),
        lockAddrs: [data.lockAddr, ...locks[keys[0]].lockAddrs],
      };
    } else {
      locks[keys[0]] = {
        lockAmt: toBN(tokenERC20Amount).toString(),
        effectiveValue: value.toString(),
        lockAddrs: [data.lockAddr],
      };
    }
  });
  // Return validating locks, locks, and total ETH locked
  return { validatingLocks, locks, totalERC20TokenLocked, totalEffectiveERC20TokenLocked };
};

const calculateEffectiveSignals = async (
  web3, lockdropContracts, blockNumber=constants.CALCULATE_SIGNALS_FROM_BLOCK
) => {
  let totalERC20TokenSignaled = toBN(0);
  let totalEffectiveERC20TokenSignaled = toBN(0);
  let signals = {};
  let seenContracts = {};
  let signalEvents = [];
  for (let index in lockdropContracts) {
    let events = await lockdropContracts[index].getPastEvents('Signaled', {
      fromBlock: 0,
      toBlock: 'latest',
    });

    signalEvents = [ ...signalEvents, ...events ];
  }
  console.log(`Signal events ${signalEvents.length}`);
  const promises = signalEvents.map(async (event) => {
    const data = event.returnValues;
    // Get balance at block that lockdrop ends
    let balance = -1;
    while (balance == -1) {
      try {
        if (blockNumber) {
          balance = await web3.eth.getBalance(data.contractAddr, blockNumber);
        } else {
          balance = await web3.eth.getBalance(data.contractAddr);
        }
      } catch(e) {
        console.log(`Couldn't find: ${JSON.stringify(data, null, 4)}`);
      }
    }

    return balance;
  });

  // Resolve promises to ensure all inner async functions have finished
  let balances = await Promise.all(promises);
  let gLocks = {};
  signalEvents.forEach((event, index) => {
    const data = event.returnValues;
    // if contract address has been seen (it is in a previously processed signal)
    // then we ignore it; this means that we only acknolwedge the first signal
    // for a given address.
    if (!(data.contractAddr in seenContracts)) {
      seenContracts[data.contractAddr] = true;
      // Get value for each signal event and add it to the collection
      let value;
      // allocate signals to first key if multiple submitted or malformed larger key submitted
      // NOTE: if key was less than length of a correct submission (66 chars), funds are considered lost
      let keys = [data.dataHighwayPublicKey];
      // FIXME - see other "FIXME [calculateEffectiveLocks-1]" for locks in this file 
      // if (data.dataHighwayPublicKey.length >= 66) {
      //   keys = data.dataHighwayPublicKey.slice(2).match(/.{1,64}/g).map(key => `0x${key}`);
      // }

      // Treat generalized locks as 3 month locks
      if (generalizedLocks.lockedContractAddresses.includes(data.contractAddr)) {
        console.log('Generalized lock:', balances[index], data.contractAddr);
        value = getEffectiveValue(balances[index], '0')
        if (keys[0] in gLocks) {
          gLocks[keys[0]] = toBN(gLocks[keys[0]]).add(value).toString();
        } else {
          gLocks[keys[0]] = value.toString();
        }
        totalERC20TokenSignaled = totalERC20TokenSignaled.add(toBN(balances[index]));
        totalEffectiveERC20TokenSignaled = totalEffectiveERC20TokenSignaled.add(value);
        // keep generalized locks collection separate from other signals
        return;
      } else {
        value = getEffectiveValue(balances[index], 'signaling');
      }
      // Add value to total signaled ETH
      totalERC20TokenSignaled = totalERC20TokenSignaled.add(toBN(balances[index]));
      totalEffectiveERC20TokenSignaled = totalEffectiveERC20TokenSignaled.add(value);
      // Iterate over signals, partition reward into delayed and immediate amounts
      if (keys[0] in signals) {
        signals[keys[0]] = {
          signalAmt: toBN(balances[index]).add(toBN(signals[keys[0]].signalAmt)).toString(),
          effectiveValue: toBN(signals[keys[0]]
                                  .effectiveValue)
                                  .add(value)
                                  .toString(),
        };
      } else {
        signals[keys[0]] = {
          signalAmt: toBN(balances[index]).toString(),
          effectiveValue: value.toString(),
        };
      }
    }
  });
  // Return signals and total ETH signaled
  return { signals, totalERC20TokenSignaled, totalEffectiveERC20TokenSignaled, genLocks: gLocks }
}

const getLockStorage = async (web3, lockAddress) => {
  return Promise.all([0,1].map(v => {
    return web3.eth.getStorageAt(lockAddress, v);
  }))
  .then(vals => {
    return {
      owner: vals[0],
      unlockTime: hexToNumber(vals[1]),
    };
  });
};

const selectDataHighwayValidators = (validatingLocks, totalAllocation, totalEffectiveETH, numOfValidators, existentialBalance=100000000000000) => {
  const sortable = [];
  // Add the calculated DataHighway balances with the respective key to a collection
  for (var key in validatingLocks) {
    const keys = key.slice(2).match(/.{1,64}/g).map(key => `0x${key}`);;
    if (keys.length === 3) {
      sortable.push([
        keys,
        toBN(validatingLocks[key].effectiveValue).sub(toBN(existentialBalance)).mul(toBN(totalAllocation)).div(totalEffectiveETH)
      ]);
    }
  }

  // Sort and take the top "numOfValidators" from the collection
  return sortable
    .sort((a,b) => (a[1].lt(b[1])) ? 1 : ((b[1].lt(a[1])) ? -1 : 0))
    .map(v => {
      return ([
        ...v[0].map(k => (k.slice(2))), // stash, controller, session
        v[1].toString(), // staked balance
      ]);
    });
};

const getDataHighwayBalanceObjects = (locks, signals, genLocks, totalAllocation, totalEffectiveETH, existentialBalance=100000000000000) => {
  console.log('locks: ', locks);
  let balances = [];
  let vesting = [];
  let key = "";
  let strippedKey = "";
  // handle locks separately than signals at first, then we'll scan over all
  // entries and ensure that there are only unique entries in the collections.
  for (const currentKey of Object.keys(locks)) {
    key = currentKey;
    console.log('key: ', key);
    strippedKey = key.slice(2);
    try {
      balances.push([
        strippedKey,
        mulByAllocationFraction(locks[key].effectiveValue, totalAllocation, totalEffectiveETH).toString(),
      ]);
      // add the vesting account to make their entire balance liquid at launch
      vesting.push([
        strippedKey,
        5256000,
        1,
        mulByAllocationFraction(toBN(locks[key].effectiveValue), totalAllocation, totalEffectiveETH).toString(),
      ]);
    } catch(e) {
      console.log(e);
      console.log(`Error processing lock event: ${key} (${locks[key].effectiveValue})`);
    }
  }
  // handle signal entries
  for (const currentKey in signals) {
    key = currentKey;
    strippedKey = key.slice(2);
    try {
      // the liquid amount of the vesting is 25% of signaled value
      const vestingValue = toBN(signals[key].effectiveValue).mul(toBN(25)).div(toBN(100));
      // create new balance record for the signaler
      balances.push([
        strippedKey,
        mulByAllocationFraction(toBN(signals[key].effectiveValue), totalAllocation, totalEffectiveETH).toString(),
      ]);
      // create vesting record for 25% liquid signal amount at launch
      vesting.push([
        strippedKey,
        5256000,
        1,
        mulByAllocationFraction(vestingValue, totalAllocation, totalEffectiveETH).toString(),
      ]);
    } catch(e) {
      console.log(e);
      console.log(`Error processing signal event: ${key} (${signals[key].effectiveValue})`);
    }
  }

  for (const currentKey in genLocks) {
    key = currentKey;
    strippedKey = key.slice(2);
    try {
      balances.push([
        strippedKey,
        mulByAllocationFraction(toBN(genLocks[key]), totalAllocation, totalEffectiveETH).toString(),
      ]);
      // add the vesting account to make their entire balance liquid at launch
      vesting.push([
        strippedKey,
        5256000,
        1,
        mulByAllocationFraction(toBN(genLocks[key]), totalAllocation, totalEffectiveETH).toString(),
      ]);
    } catch(e) {
      console.log(e);
      console.log(`Error processing lock event: ${key} (${genLocks[key]})`);
    }
  }

  return { balances: balances, vesting: vesting };
};

const combineToUnique = (balances, vesting) => {
  let balancesMap = {};
  let vestingMap = {};
  balances.forEach(entry => {
    let account = entry[0];
    let amount = entry[1];

    if (account in balancesMap) {
      balancesMap[account] = toBN(balancesMap[account]).add(toBN(amount)).toString();
    } else {
      balancesMap[account] = amount
    }
  });

  vesting.forEach(entry => {
    let account = entry[0];
    let amount = entry[3];
    try {
      if (account in vestingMap) {
        vestingMap[account] = toBN(vestingMap[account]).add(toBN(amount)).toString();
      } else {
        vestingMap[account] = amount
      }
    } catch (e) {
      console.log(e);
      console.log(entry);
      console.log(vestingMap[account]);
    }
  });

  let newBalances = []
  let newVesting = [];
  let total = toBN(0);
  Object.keys(balancesMap).forEach(key => {
    total = total.add(toBN(balancesMap[key]));
    newBalances.push([
      key,
      balancesMap[key],
    ]);
  });

  Object.keys(vestingMap).forEach(key => {
    if (toBN(balancesMap[key]).eq(toBN(vestingMap[key]))) {
      // pass
    } else {
      newVesting.push([
        key,
        5256000,
        1,
        vestingMap[key],
      ]);
    }
  });
  console.log(`Balances: ${balances.length}`);
  console.log(`Balances with vesting: ${vesting.length}`);
  console.log(`EDG Total: ${total.toString()}`);
  return { balances: newBalances, vesting: newVesting, total: total };
}

const mulByAllocationFraction = (amount, totalAllocation, totalEffectiveETH) => {
  return toBN(amount).mul(toBN(totalAllocation)).div(toBN(totalEffectiveETH));
}

module.exports = {
  getLocks,
  getSignals,
  getTotalLockedBalance,
  getTotalSignaledBalance,
  calculateEffectiveLocks,
  calculateEffectiveSignals,
  getLockStorage,
  selectDataHighwayValidators,
  getDataHighwayBalanceObjects,
  combineToUnique,
};
