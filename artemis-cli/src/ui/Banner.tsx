import { Box, Text } from "ink";
import { C } from "./theme.ts";

export const BANNER_VERSION = "v1.0.0";

const LOGO = "ARTEMIS";
const LOGO_COLORS = [C.blue, C.blue, C.sky, C.sky, C.sky, C.green, C.green];

/** Header banner: "ARTEMIS | Codebase Agent v1.0.0 (Research Preview)" + connection line. */
export function Banner(props: { model: string; connection: string; target: string; root: string }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={C.sky}>◆ </Text>
        {LOGO.split("").map((ch, i) => (
          <Text key={i} bold color={LOGO_COLORS[i]}>{ch}</Text>
        ))}
        <Text color={C.faint}> | </Text>
        <Text bold color={C.text}>Codebase Agent {BANNER_VERSION}</Text>
        <Text color={C.orange}> (Research Preview)</Text>
      </Box>
      <Box>
        <Text color={C.muted}>model </Text>
        <Text color={C.text}>{props.model}</Text>
        <Text color={C.faint}>  ·  </Text>
        <Text color={C.muted}>via </Text>
        <Text color={props.connection === "mock" ? C.orange : C.green}>{props.connection}</Text>
        <Text color={C.faint}> {props.target}</Text>
        <Text color={C.faint}>  ·  </Text>
        <Text color={C.muted}>root </Text>
        <Text color={C.text} wrap="truncate-start">{props.root}</Text>
      </Box>
    </Box>
  );
}

export function SectionTitle({ children }: { children: string }) {
  return (
    <Box paddingX={1} marginTop={1}>
      <Text color={C.sky} bold>{children.toUpperCase()}</Text>
      <Box flexGrow={1} marginLeft={1} borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderColor={C.faint} height={1} />
    </Box>
  );
}
