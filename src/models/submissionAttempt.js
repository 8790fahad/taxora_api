'use strict';

module.exports = (sequelize, DataTypes) => {
  const SubmissionAttempt = sequelize.define(
    'SubmissionAttempt',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      invoice_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      attempt_no: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      request_json: DataTypes.JSON,
      response_json: DataTypes.JSON,
      http_status: DataTypes.INTEGER,
    },
    {
      tableName: 'submission_attempts',
      underscored: true,
      updatedAt: false,
    }
  );

  SubmissionAttempt.associate = (models) => {
    SubmissionAttempt.belongsTo(models.Invoice, { foreignKey: 'invoice_id' });
  };

  return SubmissionAttempt;
};
