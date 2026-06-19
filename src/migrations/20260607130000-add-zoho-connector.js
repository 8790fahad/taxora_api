'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('erp_connections', 'connector_type', {
      type: Sequelize.ENUM('quickbooks', 'sage', 'zoho', 'manual'),
      allowNull: false,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('erp_connections', 'connector_type', {
      type: Sequelize.ENUM('quickbooks', 'sage', 'manual'),
      allowNull: false,
    });
  },
};
