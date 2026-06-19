'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('invoices', 'nrs_json', {
      type: Sequelize.JSON,
      allowNull: true,
    });
    await queryInterface.addColumn('invoices', 'invoice_email_sent_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('invoices', 'invoice_email_sent_at');
    await queryInterface.removeColumn('invoices', 'nrs_json');
  },
};
