'use strict';

const { v4: uuidv4 } = require('uuid');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const now = new Date();
    await queryInterface.bulkInsert(
      'plans',
      [
        {
          id: uuidv4(),
          code: 'per_invoice',
          name: 'Pay As You Go',
          price_ngn: 10,
          invoice_quota_monthly: 0,
          billing_type: 'per_invoice',
          billing_period: 'invoice',
          unlimited: false,
          created_at: now,
          updated_at: now,
        },
        {
          id: uuidv4(),
          code: 'yearly_unlimited',
          name: 'Annual Unlimited',
          price_ngn: 5000000,
          invoice_quota_monthly: 0,
          billing_type: 'flat',
          billing_period: 'year',
          unlimited: true,
          created_at: now,
          updated_at: now,
        },
      ],
      { ignoreDuplicates: true }
    );
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('plans', {
      code: ['per_invoice', 'yearly_unlimited'],
    });
  },
};
