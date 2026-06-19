'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('tenants', 'profile_status', {
      type: Sequelize.ENUM('verified', 'pending_review'),
      allowNull: false,
      defaultValue: 'verified',
    });
    await queryInterface.addColumn('tenants', 'verification_method', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'profile_verified_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('tenants', 'profile_status');
    await queryInterface.removeColumn('tenants', 'verification_method');
    await queryInterface.removeColumn('tenants', 'profile_verified_at');
    // Clean up the ENUM type on Postgres; harmless no-op on MySQL.
    if (queryInterface.sequelize.getDialect() === 'postgres') {
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_tenants_profile_status";');
    }
  },
};
