import { BadRequestException } from '@nestjs/common';
import { parseOpeningMoney } from './customer-opening';

describe('parseOpeningMoney', () => {
  it('defaults to zero', () => {
    expect(parseOpeningMoney(undefined, undefined).toString()).toBe('0');
    expect(parseOpeningMoney('', 'OWES').toString()).toBe('0');
  });

  it('maps OWES and CREDIT', () => {
    expect(parseOpeningMoney('150.50', 'OWES').toString()).toBe('150.5');
    expect(parseOpeningMoney('150.50', 'CREDIT').toString()).toBe('-150.5');
  });

  it('rejects negative amounts', () => {
    expect(() => parseOpeningMoney('-1', 'OWES')).toThrow(BadRequestException);
  });
});
