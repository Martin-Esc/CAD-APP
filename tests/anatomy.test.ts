import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { defaultArch, placeTeeth, archFromPicks } from '../src/core/arch';
import { archOrder, getTooth } from '../src/core/teeth';

/**
 * Handedness of the world: with +y anterior and +z toward the head, the
 * patient's right is +x (a person facing north has east on their right).
 * A mirrored world places every tooth as its contralateral twin, which is
 * invisible with symmetric procedural teeth but obvious with scanned ones.
 */
describe('anatomical handedness', () => {
  it('puts the patient\'s right teeth on +x', () => {
    for (const jaw of ['upper', 'lower'] as const) {
      const placed = placeTeeth(defaultArch(jaw));
      for (const fdi of archOrder(jaw)) {
        const side = getTooth(fdi).side;
        const x = placed.get(fdi)!.center.x;
        if (side === 'right') expect(x).toBeGreaterThan(0);
        else expect(x).toBeLessThan(0);
      }
    }
  });

  it('keeps the tooth frame right-handed: local +x = buccal × occlusal', () => {
    for (const jaw of ['upper', 'lower'] as const) {
      for (const [fdi, p] of placeTeeth(defaultArch(jaw))) {
        const x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3();
        p.matrix.extractBasis(x, y, z);
        expect(x.dot(y.clone().cross(z))).toBeCloseTo(1, 5);
        // upper right / lower left: local +x points mesially (toward the midline)
        const towardMidline = new THREE.Vector3(-Math.sign(p.center.x), 0, 0);
        const q = Math.floor(fdi / 10);
        const mesial = q === 1 || q === 3;
        if (getTooth(fdi).position <= 5 && getTooth(fdi).position >= 2) {
          expect(Math.sign(x.dot(towardMidline))).toBe(mesial ? 1 : -1);
        }
      }
    }
  });

  it('orients a picked arch the same way whatever the click order', () => {
    const picks = [new THREE.Vector3(-25, -15, 8), new THREE.Vector3(0, 22, 8), new THREE.Vector3(25, -15, 8)];
    for (const order of [picks, [...picks].reverse()]) {
      const placed = placeTeeth(archFromPicks('lower', order, 1));
      expect(placed.get(46)!.center.x).toBeGreaterThan(0); // lower right first molar on +x
      expect(placed.get(36)!.center.x).toBeLessThan(0);
    }
  });
});
