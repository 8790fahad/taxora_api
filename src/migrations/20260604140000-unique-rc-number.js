'use strict';

function normalizeRcNumber(rcNumber) {
  return String(rcNumber || '')
    .trim()
    .replace(/^RC/i, '');
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SELECT id, rc_number FROM tenants WHERE rc_number IS NOT NULL AND rc_number != \'\''
    );

    for (const row of rows) {
      const normalized = normalizeRcNumber(row.rc_number) || null;
      await queryInterface.sequelize.query('UPDATE tenants SET rc_number = ? WHERE id = ?', {
        replacements: [normalized, row.id],
      });
    }

    await queryInterface.addIndex('tenants', ['rc_number'], {
      unique: true,
      name: 'tenants_rc_number_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('tenants', 'tenants_rc_number_unique');
  },
};
