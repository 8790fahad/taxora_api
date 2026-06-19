'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('plans', 'billing_type', {
      type: Sequelize.ENUM('per_invoice', 'flat'),
      allowNull: false,
      defaultValue: 'flat',
    });
    await queryInterface.addColumn('plans', 'billing_period', {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: 'year',
    });
    await queryInterface.addColumn('plans', 'unlimited', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    // Convert the legacy Starter/Growth plans into the two new billing models.
    // Updating in place keeps the existing IDs so current subscriptions remain valid.
    await queryInterface.sequelize.query(
      `UPDATE plans SET code = 'per_invoice', name = 'Pay As You Go', price_ngn = 10,
       invoice_quota_monthly = 0, billing_type = 'per_invoice', billing_period = 'invoice',
       unlimited = false WHERE code = 'starter'`
    );
    await queryInterface.sequelize.query(
      `UPDATE plans SET code = 'yearly_unlimited', name = 'Annual Unlimited', price_ngn = 5000000,
       invoice_quota_monthly = 0, billing_type = 'flat', billing_period = 'year',
       unlimited = true WHERE code = 'growth'`
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE plans SET code = 'starter', name = 'Starter', price_ngn = 0,
       invoice_quota_monthly = 100 WHERE code = 'per_invoice'`
    );
    await queryInterface.sequelize.query(
      `UPDATE plans SET code = 'growth', name = 'Growth', price_ngn = 25000,
       invoice_quota_monthly = 1000 WHERE code = 'yearly_unlimited'`
    );
    await queryInterface.removeColumn('plans', 'unlimited');
    await queryInterface.removeColumn('plans', 'billing_period');
    await queryInterface.removeColumn('plans', 'billing_type');
  },
};
