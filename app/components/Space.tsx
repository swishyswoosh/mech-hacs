import { useColors } from "../theme/useColors.ts";
import React, { useEffect, useRef } from "react";
import { Animated, Easing, View, StyleSheet, Platform } from "react-native";
import Svg, { Circle, Path, G } from "react-native-svg";
import { useMotion } from "../theme/Theme.tsx";
export function Starfield() {
  const colors = useColors();

  const motion = useMotion();
  const opacity = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    if (Platform.OS === "web") return;
    if (!motion) {
      opacity.setValue(0.4);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.85,
          duration: 3500,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.35,
          duration: 3500,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [motion, opacity]);
  return (
    <Animated.View
      nativeID="starfield-layer"
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { opacity }]}
    >
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 1200 900"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden={true}
      >
        {Array.from({ length: 76 }, (_, i) => (
          <Circle
            key={i}
            cx={(i * 173 + 41) % 1200}
            cy={(i * 97 + 17) % 900}
            r={i % 5 === 0 ? 1.4 : 0.7}
            fill={i % 3 ? colors.textMuted : colors.primaryHi}
          />
        ))}
        <G stroke={colors.line} strokeWidth={0.4} opacity={0.25}>
          {Array.from({ length: 43 }, (_, i) => (
            <Path key={i} d={`M${i * 28} 0v900 M0 ${i * 28}h1200`} />
          ))}
        </G>
      </Svg>
    </Animated.View>
  );
}
export function Radar({size = 250}: {size?: number}) {
  const colors = useColors();

  const motion = useMotion();
  const rotation = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (Platform.OS === "web") return;
    rotation.setValue(0);
    if (!motion) return;
    const animation = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 6500,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [motion, rotation]);
  return (
    <View style={{ width: size, height: size, alignSelf: "center" }}>
      <Svg width="100%" height="100%" viewBox="0 0 250 250" aria-hidden={true}>
        {[116, 82, 44].map((r) => (
          <Circle
            key={r}
            cx={125}
            cy={125}
            r={r}
            stroke={colors.line2}
            fill="none"
          />
        ))}
        <Path d="M9 125h232M125 9v232" stroke={colors.line2} />
        <Circle cx={125} cy={125} r={6} fill={colors.primary} />
        <Circle cx={177} cy={62} r={4} fill={colors.primary} />
        <Circle cx={57} cy={167} r={3} fill={colors.primaryHi} />
      </Svg>
      <Animated.View
        nativeID="radar-sweep"
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            transform: [
              {
                rotate: rotation.interpolate({
                  inputRange: [0, 1],
                  outputRange: ["0deg", "360deg"],
                }),
              },
            ],
          },
        ]}
      >
        <Svg
          width="100%"
          height="100%"
          viewBox="0 0 250 250"
          aria-hidden={true}
        >
          <Path d="M125 125L125 9A116 116 0 0 0 25 67Z" fill={colors.tint} />
          <Path d="M125 125V9" stroke={colors.primary} strokeWidth={2} />
        </Svg>
      </Animated.View>
    </View>
  );
}
export function HyperspaceStreaks() {
  const colors = useColors();

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 1200 700"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden={true}
      >
        <G stroke={colors.primary} opacity={0.07}>
          {Array.from({ length: 20 }, (_, i) => {
            const a = (i * Math.PI) / 10;
            return (
              <Path
                key={i}
                d={`M${600 + Math.cos(a) * 250} ${350 + Math.sin(a) * 250}L${600 + Math.cos(a) * 750} ${350 + Math.sin(a) * 750}`}
              />
            );
          })}
        </G>
      </Svg>
    </View>
  );
}
