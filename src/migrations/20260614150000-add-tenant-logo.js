'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('tenants', 'logo_url', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'logo_width', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'logo_height', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('tenants', 'logo_url');
    await queryInterface.removeColumn('tenants', 'logo_width');
    await queryInterface.removeColumn('tenants', 'logo_height');
  },
};
