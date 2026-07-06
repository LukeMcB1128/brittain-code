# Enhanced Tool Definitions for Brittain Code

Based on the analysis of the existing code, here are enhanced tool definitions that would be useful for a coding agent:

## Current Tools (from main.js):
1. `read_file` - Read text files
2. `write_file` - Write/overwrite files
3. `list_directory` - List directory contents
4. `run_command` - Execute shell commands
5. `search_files` - Search for text patterns in files

## Proposed Additional Tools:

### File Operations
1. **`append_file`** - Append content to files
2. **`create_directory`** - Create new directories
3. **`delete_file`** - Delete files
4. **`copy_file`** - Copy files
5. **`move_file`** - Move/rename files
6. **`file_info`** - Get file metadata (size, permissions, etc.)
7. **`get_file_lines`** - Get specific lines from a file
8. **`count_lines`** - Count total lines in a file
9. **`get_file_type`** - Determine file type by extension
10. **`replace_in_file`** - Replace text patterns in files using regex

### Search & Find Operations
1. **`search_in_file`** - Search for patterns within a specific file
2. **`find_files`** - Find files matching glob patterns
3. **`find_largest_files`** - Find largest files in directory

### Utility Tools
1. **`get_working_directory`** - Get current working directory (useful for context)
2. **`get_system_info`** - Get system information (OS, CPU, memory)
3. **`list_processes`** - List running processes
4. **`get_environment`** - Get environment variables

## Integration Points

### 1. TOOL_DEFS Array (in main.js)
Add the new tool definitions to the existing TOOL_DEFS array.

### 2. executeTool Function (in main.js)
Add new cases for the additional tools in the executeTool switch statement.

### 3. RISKY_TOOLS Set (in main.js) 
Add new risky tools to the set (tools that require user approval).

### 4. Additional Dependencies
Consider adding:
- `glob` package for file pattern matching
- `os` module for system information
- `child_process` for process management

## Implementation Notes

The enhanced tools would provide:
- Better file management capabilities
- More precise search and replace functionality
- Enhanced debugging and analysis tools
- Improved system awareness
- Better error handling and validation