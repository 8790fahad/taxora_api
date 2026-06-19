'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('tenants', 'address_line', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'address_city', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'address_country', {
      type: Sequelize.STRING(2),
      allowNull: true,
      defaultValue: 'NG',
    });
    await queryInterface.addColumn('tenants', 'address_postal_zone', {
      type: Sequelize.STRING,
      allowNull: true,
    });

    // Carry any existing free-text address into the new street line.
    await queryInterface.sequelize.query(
      "UPDATE tenants SET address_line = address WHERE address IS NOT NULL AND (address_line IS NULL OR address_line = '')"
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('tenants', 'address_postal_zone');
    await queryInterface.removeColumn('tenants', 'address_country');
    await queryInterface.removeColumn('tenants', 'address_city');
    await queryInterface.removeColumn('tenants', 'address_line');
  },
};
