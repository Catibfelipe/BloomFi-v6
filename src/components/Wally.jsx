import React from 'react';

export default function Wally({ mood = 'happy', size = 42 }) {
  return (
    <div className={`wally ${mood}`} style={{ width: size, height: size }} aria-hidden="true">
      <div className="ear left" /><div className="ear right" />
      <div className="eye l" /><div className="eye r" />
      <div className="beak" />
      <div className="wing left" /><div className="wing right" />
      {mood === 'sleep' && <span className="zzz">z</span>}
    </div>
  );
}
