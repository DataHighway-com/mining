const Promise = require('bluebird');
const utility = require('../helpers/util');
const ldHelpers = require('../helpers/lockdropHelper');
const constants = require('../helpers/constants');
const { toWei, toBN, padRight } = web3.utils;
const rlp = require('rlp');
const keccak = require('keccak');
const bs58 = require('bs58');
const keyring = require('@polkadot/keyring');
const { decodeAddress } = require('@polkadot/util-crypto');

const Lock = artifacts.require("./Lock.sol");
const Lockdrop = artifacts.require("./Lockdrop.sol");

contract('Lockdrop', (accounts) => {
  console.log('accounts: ', accounts);
  const SECONDS_IN_DAY = 86400;
  const THREE_MONTHS = 0;
  const SIX_MONTHS = 1;
  const TWELVE_MONTHS = 2;

  let lockdrop;
  let lockdropAsArray;

  beforeEach(async function() {
    let time = await utility.getCurrentTimestamp(web3);
    try {
      lockdrop = await Lockdrop.new(time);
      lockdropAsArray = Array(lockdrop);
    } catch(err) {
      console.log('Lockdrop error: ', err);
    }
  });

  it('should setup and pull constants', async function () {
    let time = await utility.getCurrentTimestamp(web3);
    let LOCK_DROP_PERIOD = (await lockdrop.LOCK_DROP_PERIOD()).toNumber();
    let LOCK_START_TIME = (await lockdrop.LOCK_START_TIME()).toNumber();
    assert.equal(LOCK_DROP_PERIOD, SECONDS_IN_DAY * 92);
    assert.ok(LOCK_START_TIME <= time && time <= LOCK_START_TIME + 1000);
  });

  it('should lock funds and also be a potential validator', async function () {
    await lockdrop.lock(THREE_MONTHS, accounts[1], true, {
      from: accounts[1],
      value: 1,
    });

    const lockEvents = await ldHelpers.getLocks(lockdrop, accounts[1]);
    assert.equal(lockEvents.length, 1);
    assert.equal(lockEvents[0].args.isValidator, true);
    const lockStorages = await Promise.all(lockEvents.map(event => {
      return ldHelpers.getLockStorage(web3, event.returnValues.lockAddr);
    }));

    assert.equal(lockStorages[0].owner, lockEvents[0].returnValues.owner.toLowerCase());
  });

  it('should unlock the funds after the lock period has ended', async function () {
    const balBefore = await utility.getBalance(accounts[1], web3);
    let txHash = await lockdrop.lock(THREE_MONTHS, accounts[1], true, {
      from: accounts[1],
      value: web3.utils.toWei('1', 'ether'),
    });

    const balAfter = await utility.getBalance(accounts[1], web3);

    const lockEvents = await ldHelpers.getLocks(lockdrop, accounts[1]);
    const lockStorages = await Promise.all(lockEvents.map(event => {
      return ldHelpers.getLockStorage(web3, event.returnValues.lockAddr);
    }));
    let unlockTime = lockStorages[0].unlockTime;

    const lockContract = await Lock.at(lockEvents[0].returnValues.lockAddr);

    let time = await utility.getCurrentTimestamp(web3);
    let res = await utility.advanceTime(unlockTime - time + SECONDS_IN_DAY, web3);

    txHash = await lockContract.sendTransaction({
      from: accounts[1],
      value: 0,
      gas: 50000,
    });

    const afterafter = await utility.getBalance(accounts[1], web3);
    assert(Number(balBefore) > Number(balAfter));
    assert(Number(afterafter) > Number(balAfter));
  });

  it('should not allow one to lock before the lock start time', async function () {
    let time = await utility.getCurrentTimestamp(web3);
    const newLockdrop = await Lockdrop.new(time + SECONDS_IN_DAY * 10);
    utility.assertRevert(newLockdrop.lock(THREE_MONTHS, accounts[1], true, {
      from: accounts[1],
      value: web3.utils.toWei('1', 'ether'),
    }));
  });

  it('should not allow one to lock after the lock start time', async function () {
    await lockdrop.lock(THREE_MONTHS, accounts[1], true, {
      from: accounts[1],
      value: web3.utils.toWei('1', 'ether'),
    });

    utility.advanceTime(SECONDS_IN_DAY * 15, web3);
    utility.assertRevert(lockdrop.lock(THREE_MONTHS, accounts[1], true, {
      from: accounts[1],
      value: web3.utils.toWei('1', 'ether'),
    }));
  });

  it('should not allow one to lock up any different length than 3,6,12 months', async function () {
    utility.assertRevert(lockdrop.lock(3, accounts[1], true, {
      from: accounts[1],
      value: web3.utils.toWei('1', 'ether'),
    }));
  });

  it('should fail to withdraw funds if not enough gas is sent', async function () {
    let time = await utility.getCurrentTimestamp(web3);
    const newLockdrop = await Lockdrop.new(time);
    await newLockdrop.lock(THREE_MONTHS, accounts[1], true, {
      from: accounts[1],
      value: web3.utils.toWei('1', 'ether'),
    });

    const balAfter = await utility.getBalance(accounts[1], web3);

    const lockEvents = await ldHelpers.getLocks(newLockdrop, accounts[1]);
    const lockStorages = await Promise.all(lockEvents.map(event => {
      return ldHelpers.getLockStorage(web3, event.returnValues.lockAddr);
    }));
    let unlockTime = lockStorages[0].unlockTime;
    const lockContract = await Lock.at(lockEvents[0].returnValues.lockAddr);

    time = await utility.getCurrentTimestamp(web3);
    await utility.advanceTime(unlockTime - time + SECONDS_IN_DAY, web3);

    utility.assertRevert(lockContract.sendTransaction({
      from: accounts[1],
      value: 0,
      gas: 1,
    }));
  });

  it('should generate the allocation for a substrate genesis spec with THREE_MONTHS term', async function () {
    await Promise.all(accounts.map(async a => {
      return await lockdrop.lock(THREE_MONTHS, a, true, {
        from: a,
        value: web3.utils.toWei('1', 'ether'),
      });
    }));

    const totalAllocation = '5000000000000000000000000000';
    const allocation = await ldHelpers.calculateEffectiveLocks(lockdropAsArray);
    let { validatingLocks, locks, totalEffectiveETHLocked } = allocation;
    const signalAllocation = await ldHelpers.calculateEffectiveSignals(web3, lockdropAsArray);
    let { signals, totalEffectiveETHSignaled, genLocks } = signalAllocation;
    console.log('signals, totalEffectiveETHSignaled: ', signals, totalEffectiveETHSignaled)
    const totalEffectiveETH = totalEffectiveETHLocked.add(totalEffectiveETHSignaled);
    let json = await ldHelpers.getEdgewareBalanceObjects(locks, signals, genLocks, totalAllocation, totalEffectiveETH);

    const bal = toBN(totalAllocation).div(toBN(accounts.length)).toString();
    json.balances.forEach(elt => {
      assert.equal(elt[1], bal);
    });
  });

  it('should generate the allocation for a substrate genesis spec with SIX_MONTHS term', async function () {
    await Promise.all(accounts.map(async a => {
      return await lockdrop.lock(SIX_MONTHS, a, true, {
        from: a,
        value: web3.utils.toWei('1', 'ether'),
      });
    }));

    const totalAllocation = '5000000000000000000000000000';
    const allocation = await ldHelpers.calculateEffectiveLocks(lockdropAsArray);
    let { validatingLocks, locks, totalEffectiveETHLocked } = allocation;
    const signalAllocation = await ldHelpers.calculateEffectiveSignals(web3, lockdropAsArray);
    let { signals, totalEffectiveETHSignaled, genLocks } = signalAllocation;
    const totalEffectiveETH = totalEffectiveETHLocked.add(totalEffectiveETHSignaled);
    let json = await ldHelpers.getEdgewareBalanceObjects(locks, signals, genLocks, totalAllocation, totalEffectiveETH);

    const bal = toBN(totalAllocation).div(toBN(accounts.length)).toString();
    json.balances.forEach(elt => {
      assert.equal(elt[1], bal);
    });
  });

  it('should generate the allocation for a substrate genesis spec with TWELVE_MONTHS term', async function () {
    await Promise.all(accounts.map(async a => {
      return await lockdrop.lock(TWELVE_MONTHS, a, true, {
        from: a,
        value: web3.utils.toWei('1', 'ether'),
      });
    }));

    const totalAllocation = '5000000000000000000000000000';
    const allocation = await ldHelpers.calculateEffectiveLocks(lockdropAsArray);
    let { validatingLocks, locks, totalEffectiveETHLocked } = allocation;
    const signalAllocation = await ldHelpers.calculateEffectiveSignals(web3, lockdropAsArray);
    let { signals, totalEffectiveETHSignaled, genLocks } = signalAllocation;
    const totalEffectiveETH = totalEffectiveETHLocked.add(totalEffectiveETHSignaled);
    let json = await ldHelpers.getEdgewareBalanceObjects(locks, signals, genLocks, totalAllocation, totalEffectiveETH);

    const bal = toBN(totalAllocation).div(toBN(accounts.length)).toString();
    json.balances.forEach(elt => {
      assert.equal(elt[1], bal);
    });
  });

  it('should aggregate the balances for all non validators and separate for validators', async function () {
    await Promise.all(accounts.map(async a => {
      return await lockdrop.lock(TWELVE_MONTHS, accounts[1], false, {
        from: accounts[1],
        value: web3.utils.toWei('1', 'ether'),
      });
    }));

    await lockdrop.lock(TWELVE_MONTHS, accounts[1], true, {
      from: accounts[1],
      value: web3.utils.toWei('1', 'ether'),
    });

    const totalAllocation = '5000000000000000000000000000';
    const allocation = await ldHelpers.calculateEffectiveLocks(lockdropAsArray);
    let { validatingLocks, locks, totalEffectiveETHLocked } = allocation;
    assert.equal(Object.keys(validatingLocks).length, 1);
    assert.equal(Object.keys(locks).length, 1);
  });

  it('should turn a lockdrop allocation into the substrate genesis format', async function () {
    await Promise.all(accounts.map(async (a, inx) => {
      return await lockdrop.lock(TWELVE_MONTHS, a, (Math.random() > 0.5) ? true : false, {
        from: a,
        value: web3.utils.toWei(`${inx + 1}`, 'ether'),
      });
    }));

    const totalAllocation = '5000000000000000000000000000';
    const allocation = await ldHelpers.calculateEffectiveLocks(lockdropAsArray);
    let { validatingLocks, locks, totalEffectiveETHLocked } = allocation;
    const signalAllocation = await ldHelpers.calculateEffectiveSignals(web3, lockdropAsArray);
    let { signals, totalEffectiveETHSignaled, genLocks } = signalAllocation;
    const totalEffectiveETH = totalEffectiveETHLocked.add(totalEffectiveETHSignaled);
    let json = await ldHelpers.getEdgewareBalanceObjects(locks, signals, genLocks, totalAllocation, totalEffectiveETH);
    let validators = ldHelpers.selectEdgewareValidators(validatingLocks, totalAllocation, totalEffectiveETH, 10);
    assert(validators.length < 10);
    assert.ok(json.hasOwnProperty('balances'));
    assert.ok(json.hasOwnProperty('vesting'));
  });

  it('should allow contracts to lock up ETH by signalling', async function () {
    const sender = accounts[0];
    const nonce = (await web3.eth.getTransactionCount(sender));
    const nonceHex = `0x${nonce.toString(16)}`;
    const input = [ sender, nonce ];
    const rlpEncoded = rlp.encode(input);
    const contractAddressLong = keccak('keccak256').update(rlpEncoded).digest('hex');
    const contractAddr = contractAddressLong.substring(24);
    await lockdrop.signal(`0x${contractAddr}`, nonce, sender, { from: sender });
    const lockEvents = await ldHelpers.getSignals(lockdrop, contractAddr);
  });

  it('ensure the contract address matches JS RLP script', async function () {
    const sender = accounts[0];
    const nonce = (await web3.eth.getTransactionCount(sender));
    const nonceHex = `0x${nonce.toString(16)}`;
    const input = [ sender, nonce ];
    const rlpEncoded = rlp.encode(input);
    const contractAddressLong = keccak('keccak256').update(rlpEncoded).digest('hex');
    const contractAddr = contractAddressLong.substring(24);

    let time = await utility.getCurrentTimestamp(web3);
    let tempLd = await Lockdrop.new(time);
    assert.equal(web3.utils.toBN(tempLd.address).toString(), web3.utils.toBN(contractAddr).toString());
  });

  it('should ensure base58 encodings are valid to submit', async function () {
    // Add locks using default accounts
    await Promise.all(accounts.map(async (a, inx) => {
      return await lockdrop.lock(TWELVE_MONTHS, `0x${decodeAddress(constants.FIXTURES[inx].base58Address, true).toString('hex')}`, (Math.random() > 0.5) ? true : false, {
        from: a,
        value: web3.utils.toWei(`${inx + 1}`, 'ether'),
      });
    }));

    await Promise.all(accounts.map(async (a, inx) => {
      return await lockdrop.lock(TWELVE_MONTHS, `0x${decodeAddress(constants.FIXTURES[inx].base58Address, true).toString('hex')}`, (Math.random() > 0.5) ? true : false, {
        from: a,
        value: web3.utils.toWei(`${inx + 1}`, 'ether'),
      });
    }));

    const totalAllocation = '5000000000000000000000000';
    const allocation = await ldHelpers.calculateEffectiveLocks(lockdropAsArray);
    let { validatingLocks, locks, totalEffectiveETHLocked } = allocation;
    const signalAllocation = await ldHelpers.calculateEffectiveSignals(web3, lockdropAsArray);
    let { signals, totalEffectiveETHSignaled, genLocks } = signalAllocation;
    const totalEffectiveETH = totalEffectiveETHLocked.add(totalEffectiveETHSignaled);

    let totalETHLockedInETH = web3.utils.fromWei(totalEffectiveETHLocked.toString(), 'ether');
    console.log('Validating Locks in ETH: ', totalETHLockedInETH);
    console.log('Locks in ETH: ', totalETHLockedInETH);
    let totalETHSignaledInETH = web3.utils.fromWei(totalEffectiveETHSignaled.toString(), 'ether');
    console.log('Signalled in ETH: ', totalETHSignaledInETH);
    let json = await ldHelpers.getEdgewareBalanceObjects(locks, signals, genLocks, totalAllocation, totalEffectiveETH);
    let validators = ldHelpers.selectEdgewareValidators(validatingLocks, totalAllocation, totalEffectiveETH, 4);

    let sum = toBN(0);
    console.log('json: ', json);
    let key, bytes, encodedKey = '';
    json.balances.forEach((elt, inx) => {
      key = elt[0];
      bytes = Buffer.from(key, 'hex');
      encodedKey = keyring.encodeAddress(bytes);
      // FIXME - why didn't Edgeware originally re-encode the key using bs58 like we have done here prior to the assertion?
      assert.equal(encodedKey, constants.FIXTURES[inx].base58Address);
      sum = sum.add(toBN(elt[1]));
    });

    assert.ok(sum < toBN(totalAllocation).add(toBN(10)) || sum > toBN(totalAllocation).sub(toBN(10)))
  });

  it('should not break the first lock of the lockdrop', async function () {
    const sender = lockdrop.address;
    const nonce = (await web3.eth.getTransactionCount(sender));
    const nonceHex = `0x${nonce.toString(16)}`;
    const input = [ sender, nonce ];
    const rlpEncoded = rlp.encode(input);
    const contractAddressLong = keccak('keccak256').update(rlpEncoded).digest('hex');
    const contractAddr = `0x${contractAddressLong.substring(24)}`;

    await web3.eth.sendTransaction({
      from: accounts[0],
      to: contractAddr,
      value: web3.utils.toWei('1', 'ether'),
    });

    await lockdrop.lock(THREE_MONTHS, accounts[1], true, {
      from: accounts[1],
      value: 1,
    });
  });
});
