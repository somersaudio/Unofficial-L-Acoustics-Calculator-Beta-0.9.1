import { useEffect, useRef } from 'react';

interface MatrixRainProps {
  /** Array of sentences to display as falling trails */
  sentences?: string[];
  /** Opacity of the effect (0-1) */
  opacity?: number;
}

interface Drop {
  y: number;
  speed: number;
  chars: string[]; // Characters for the trail (one sentence)
  greenShade: number;
}

// Default sentences for the Matrix effect
const DEFAULT_SENTENCES = [
  "L-ACOUSTICS AMPLIFICATION",
  "LA12X POWERING THE FUTURE",
  "KARA II LINE SOURCE",
  "K2 LARGE FORMAT WST",
  "SYVA COLINEAR SOURCE",
  "IMPEDANCE MATTERS",
  "PROFESSIONAL AUDIO",
  "SOUND EXCELLENCE",
  "DRIVEN BY INNOVATION",
  "AMPLIFIED PERFECTION",
];

/**
 * Matrix-style falling text rain effect
 * Uses sentences as falling trails
 */
export default function MatrixRain({ sentences = DEFAULT_SENTENCES, opacity = 0.15 }: MatrixRainProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Use provided sentences or defaults
    const sentenceList = sentences.length > 0 ? sentences : DEFAULT_SENTENCES;

    // Configuration
    const fontSize = 14;
    const columnWidth = fontSize;

    // Resize handler
    const resize = () => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    };
    resize();

    // Initialize columns
    let columns = Math.floor(canvas.width / columnWidth);
    let drops: Drop[] = [];

    // Get a random sentence and convert to reversed character array
    // Reversed so when drawn bottom-to-top from the head, it reads top-to-bottom
    const getRandomSentence = (): string[] => {
      const sentence = sentenceList[Math.floor(Math.random() * sentenceList.length)];
      return sentence.split('').reverse();
    };

    const initDrops = () => {
      columns = Math.floor(canvas.width / columnWidth);
      drops = [];
      for (let i = 0; i < columns; i++) {
        const chars = getRandomSentence();
        drops[i] = {
          y: Math.random() * -50, // Start above screen
          speed: (0.5 + Math.random() * 1.5) / 8, // 1/8 speed
          chars,
          greenShade: Math.floor(Math.random() * 6),
        };
      }
    };
    initDrops();

    // Green color variations - from bright to dark
    const getGreenColor = (baseShade: number, trailIndex: number, trailLength: number): string => {
      // Base greens (brightest)
      const baseGreens = [
        [0, 255, 0],    // Bright green
        [0, 204, 0],    // Medium green
        [0, 153, 0],    // Dark green
        [51, 255, 51],  // Light bright green
        [0, 255, 102],  // Cyan-green
        [102, 255, 0],  // Yellow-green
      ];

      const base = baseGreens[baseShade % baseGreens.length];

      // Calculate darkness based on trail position (0 = head, brightest)
      const darkenFactor = 1 - (trailIndex / trailLength);
      const r = Math.floor(base[0] * darkenFactor);
      const g = Math.floor(base[1] * darkenFactor);
      const b = Math.floor(base[2] * darkenFactor);

      return `rgb(${r}, ${g}, ${b})`;
    };

    const draw = () => {
      // Clear canvas completely (no trail overlay)
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.font = `${fontSize}px monospace`;

      for (let i = 0; i < drops.length; i++) {
        const drop = drops[i];
        const headY = drop.y * fontSize;
        const trailLength = drop.chars.length;

        // Draw each character in the trail - head at bottom (brightest), trail going up
        for (let t = 0; t < trailLength; t++) {
          const charY = headY - (t * fontSize);

          // Skip if above canvas
          if (charY < 0) continue;
          // Skip if below canvas
          if (charY > canvas.height + fontSize) continue;

          // Get color based on trail position (0 = head/bottom, brightest)
          const color = getGreenColor(drop.greenShade, t, trailLength);
          ctx.fillStyle = color;

          // Draw character
          ctx.fillText(drop.chars[t], i * columnWidth, charY);
        }

        // Occasionally flash the head white
        if (Math.random() > 0.98) {
          ctx.fillStyle = '#ffffff';
          ctx.fillText(drop.chars[0], i * columnWidth, headY);
        }

        // Move drop down
        drop.y += drop.speed;

        // Reset drop when entire trail is off screen (top of trail past bottom)
        if ((drop.y - trailLength) * fontSize > canvas.height && Math.random() > 0.975) {
          drop.y = Math.random() * -20;
          drop.speed = (0.5 + Math.random() * 1.5) / 8; // 1/8 speed
          drop.chars = getRandomSentence();
          drop.greenShade = Math.floor(Math.random() * 6);
        }
      }

      animationRef.current = requestAnimationFrame(draw);
    };

    // Start animation
    draw();

    // Handle resize
    const handleResize = () => {
      resize();
      initDrops();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      window.removeEventListener('resize', handleResize);
    };
  }, [sentences]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ opacity }}
    />
  );
}
