'use strict';

module.exports = (sequelize, DataTypes) => {
  const Plan = sequelize.define(
    'Plan',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      code: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      price_ngn: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      invoice_quota_monthly: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
      },
      billing_type: {
        type: DataTypes.ENUM('per_invoice', 'flat'),
        allowNull: false,
        defaultValue: 'flat',
      },
      billing_period: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'year',
      },
      unlimited: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      tableName: 'plans',
      underscored: true,
    }
  );

  Plan.associate = (models) => {
    Plan.hasMany(models.Subscription, { foreignKey: 'plan_id' });
  };

  return Plan;
};
