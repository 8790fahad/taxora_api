'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('tenants', 'primary_phone', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'state', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'company_classification', {
      type: Sequelize.STRING,
      allowNull: true,
      comment: '1-5 KIRS CAC classification code',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('tenants', 'company_classification');
    await queryInterface.removeColumn('tenants', 'state');
    await queryInterface.removeColumn('tenants', 'primary_phone');
  },
};
