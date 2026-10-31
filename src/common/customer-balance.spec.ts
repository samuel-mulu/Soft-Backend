import { toDisplayBottle, toDisplayMoney } from './customer-balance';

describe('FlowStock display balances', () => {
  it('converts money: internal debt to negative display', () => {
    expect(toDisplayMoney(100)).toBe(-100);
    expect(toDisplayMoney(-400)).toBe(400);
  });

  it('converts bottles: internal with-customer to negative display', () => {
    expect(toDisplayBottle(8)).toBe(-8);
    expect(toDisplayBottle(-5)).toBe(5);
  });
});

describe('Scenario A — normal sale', () => {
  it('money −100 and bottles −8 after partial pay', () => {
    const internalMoney = 1000 - 900;
    const internalBottles = 10 - 2;
    expect(toDisplayMoney(internalMoney)).toBe(-100);
    expect(toDisplayBottle(internalBottles)).toBe(-8);
  });
});

describe('Scenario B — overpay and over-return', () => {
  it('money +400 and bottles +2', () => {
    const internalMoney = 1000 - 1400;
    const internalBottles = 8 - 10;
    expect(toDisplayMoney(internalMoney)).toBe(400);
    expect(toDisplayBottle(internalBottles)).toBe(2);
  });
});

describe('Scenario C — over-return on sale', () => {
  it('bottles +5 display', () => {
    expect(toDisplayBottle(10 - 15)).toBe(5);
  });
});

describe('Scenario D — debt then large payment', () => {
  it('final +500 display', () => {
    const internalBefore = 500;
    const sale = 1000;
    const pay = 2000;
    expect(toDisplayMoney(internalBefore + sale - pay)).toBe(500);
  });
});

describe('Scenario E — existing bottle debt', () => {
  it('final +5 display', () => {
    const internal = 20 + 10 - 35;
    expect(toDisplayBottle(internal)).toBe(5);
  });
});
