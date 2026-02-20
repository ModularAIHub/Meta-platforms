import React from 'react';

const LoadingSpinner = ({ size = 'md' }) => {
  const classes = {
    sm: 'h-4 w-4 border-2',
    md: 'h-6 w-6 border-2',
    lg: 'h-8 w-8 border-3',
  };

  return (
    <div
      className={`animate-spin rounded-full border-blue-600 border-t-transparent ${classes[size] || classes.md}`}
      aria-label="Loading"
    />
  );
};

export default LoadingSpinner;
